require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const app = express();

const PORT = Number(process.env.PORT || 5000);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const CURRENCY = (process.env.PAYMENT_CURRENCY || "NGN").toUpperCase();

const BASE_URL = (
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`
).replace(/\/+$/, "");

const FRONTEND_URL = (
  process.env.FRONTEND_URL || "http://localhost:5501"
).replace(/\/+$/, "");

const SESSION_SECRET = process.env.SESSION_SECRET || "";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";

const TIME_ZONE = process.env.BOOKING_TIME_ZONE || "Africa/Lagos";
const PENDING_HOLD_MINUTES = Number(
  process.env.PENDING_HOLD_MINUTES || 15
);

const FRONTEND_ORIGINS = [
  ...new Set(
    (
      process.env.FRONTEND_ORIGINS ||
      "http://127.0.0.1:5501,http://localhost:5501"
    )
      .split(",")
      .map(value => value.trim().replace(/\/+$/, ""))
      .filter(Boolean)
  ),
];

if (
  !Number.isInteger(PORT) ||
  PORT < 1 ||
  PORT > 65535
) {
  throw new Error("PORT must be a valid TCP port.");
}

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error(
    "Set SESSION_SECRET to a random secret of at least 32 characters."
  );
}

if (!ADMIN_PASSWORD_HASH) {
  throw new Error(
    "Set ADMIN_PASSWORD_HASH before starting the server."
  );
}

if (
  !SECRET_KEY.startsWith("sk_test_") &&
  !SECRET_KEY.startsWith("sk_live_")
) {
  throw new Error(
    "Configure a valid Paystack secret key."
  );
}

if (CURRENCY !== "NGN") {
  throw new Error(
    "This integration currently supports NGN only."
  );
}

if (
  !Number.isInteger(PENDING_HOLD_MINUTES) ||
  PENDING_HOLD_MINUTES < 1 ||
  PENDING_HOLD_MINUTES > 120
) {
  throw new Error(
    "PENDING_HOLD_MINUTES must be between 1 and 120."
  );
}

if (
  IS_PRODUCTION &&
  (
    !BASE_URL.startsWith("https://") ||
    !FRONTEND_URL.startsWith("https://")
  )
) {
  throw new Error(
    "Production requires HTTPS PUBLIC_BASE_URL and FRONTEND_URL."
  );
}

if (IS_PRODUCTION && FRONTEND_ORIGINS.length === 0) {
  throw new Error(
    "Configure FRONTEND_ORIGINS for production."
  );
}

function readPrice(name) {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing ${name} in environment variables.`);
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive whole number.`);
  }

  return number;
}

const PRICING = {
  rateOwn: readPrice("RATE_OWN"),
  rateVeh: readPrice("RATE_VEH"),
  minHours: readPrice("MIN_HOURS"),
  maxHours: readPrice("MAX_HOURS"),
};

if (
  PRICING.minHours > PRICING.maxHours ||
  PRICING.minHours < 1 ||
  PRICING.maxHours > 24
) {
  throw new Error(
    "Configure valid MIN_HOURS and MAX_HOURS values."
  );
}

if (IS_PRODUCTION) {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

// ---------- Security and CORS ----------

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        FRONTEND_ORIGINS.includes(origin) ||
        origin === BASE_URL
      ) {
        return callback(null, true);
      }

      return callback(
        new Error("Origin not allowed by CORS.")
      );
    },
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "X-CSRF-Token",
    ],
  })
);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 150,
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many login attempts. Try again later.",
  },
});

app.use(generalLimiter);

// ---------- Persistent storage ----------

// On Render, mount a persistent disk at /var/data and set:
// DATA_DIR=/var/data
//
// Local development defaults to server/data.
// Existing databases are not automatically moved when DATA_DIR changes.

const configuredDataDir = process.env.DATA_DIR || "data";

const DATA_DIR = path.isAbsolute(configuredDataDir)
  ? configuredDataDir
  : path.resolve(__dirname, configuredDataDir);

fs.mkdirSync(DATA_DIR, { recursive: true });

const configuredDatabasePath = process.env.DATABASE_PATH;

const dbPath = configuredDatabasePath
  ? (
      path.isAbsolute(configuredDatabasePath)
        ? configuredDatabasePath
        : path.resolve(__dirname, configuredDatabasePath)
    )
  : path.join(DATA_DIR, "mimz-ride.sqlite");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    service_type TEXT NOT NULL,
    hours INTEGER NOT NULL,
    hourly_rate INTEGER NOT NULL,
    amount_kobo INTEGER NOT NULL,
    currency TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    pickup TEXT NOT NULL,
    dropoff TEXT NOT NULL DEFAULT '',
    booking_date TEXT NOT NULL,
    booking_time TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    paystack_transaction_id TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS bookings_reference_index
  ON bookings(reference);

  CREATE INDEX IF NOT EXISTS bookings_schedule_index
  ON bookings(booking_date, booking_time);

  CREATE TABLE IF NOT EXISTS availability_blocks (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS availability_blocks_range_index
  ON availability_blocks(start_at, end_at);
`);

function ensureColumn(table, column, definition) {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all();

  if (!columns.some(item => item.name === column)) {
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
    );
  }
}

// Migrate existing databases without deleting existing bookings.
ensureColumn(
  "bookings",
  "booking_status",
  "TEXT NOT NULL DEFAULT 'pending'"
);

ensureColumn("bookings", "hold_expires_at", "TEXT");

// ---------- Shared helpers ----------

const nowIso = () => new Date().toISOString();

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function textField(value, name, maxLength = 300) {
  if (typeof value !== "string") {
    throw httpError(`${name} is required.`);
  }

  const result = value.trim();

  if (!result || result.length > maxLength) {
    throw httpError(
      `${name} is required and must not exceed ${maxLength} characters.`
    );
  }

  return result;
}

function optionalText(value, maxLength = 300) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function emailField(value) {
  const email = textField(value, "Email", 254).toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError("Enter a valid email address.");
  }

  return email;
}

function normalizeServiceType(value) {
  if (value === "own") return "own";
  if (value === "veh" || value === "vehicle") return "veh";

  throw httpError("Choose a valid service.");
}

function validDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function validTime(value) {
  return (
    typeof value === "string" &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
  );
}

function localDateTimeKey(date, time) {
  return `${date}T${time}`;
}

// Booking dates are stored as local wall-clock values.
// The default Africa/Lagos time zone has no daylight-saving transitions.
function addMinutes(date, time, minutes) {
  const start = new Date(`${date}T${time}:00Z`);

  start.setUTCMinutes(start.getUTCMinutes() + minutes);

  return start.toISOString().slice(0, 16);
}

function zonedNowKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function validateSchedule(date, time, hours) {
  if (!validDate(date)) {
    throw httpError("Enter a valid booking date.");
  }

  if (!validTime(time)) {
    throw httpError("Enter a valid booking time.");
  }

  const startAt = localDateTimeKey(date, time);
  const endAt = addMinutes(date, time, hours * 60);

  if (startAt <= zonedNowKey()) {
    throw httpError("Choose a future booking date and time.");
  }

  return { startAt, endAt };
}

function generateReference() {
  return `MIMZ-${crypto.randomUUID().replace(/-/g, "")}`;
}

function publicBooking(row) {
  return {
    reference: row.reference,
    status: row.status,
    paymentStatus: row.payment_status,
    serviceType: row.service_type,
    hours: row.hours,
    amount: row.amount_kobo / 100,
    currency: row.currency,
    bookingDate: row.booking_date,
    bookingTime: row.booking_time,
    paidAt: row.paid_at,
  };
}

function adminBooking(row) {
  return {
    ...publicBooking(row),
    id: row.id,
    bookingStatus: row.booking_status || "pending",
    hourlyRate: row.hourly_rate,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    pickup: row.pickup,
    dropoff: row.dropoff,
    notes: row.notes,
    transactionId: row.paystack_transaction_id,
    holdExpiresAt: row.hold_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getBooking(reference) {
  return db
    .prepare("SELECT * FROM bookings WHERE reference = ?")
    .get(reference);
}

function bookingBlocksSchedule(row, now = nowIso()) {
  if (
    row.booking_status === "cancelled" ||
    row.booking_status === "payment_review"
  ) {
    return false;
  }

  if (
    row.payment_status === "success" ||
    row.status === "paid"
  ) {
    return true;
  }

  return (
    row.payment_status === "pending" &&
    Boolean(row.hold_expires_at) &&
    row.hold_expires_at > now
  );
}

function findScheduleConflict(
  startAt,
  endAt,
  excludeReference = null
) {
  const now = nowIso();
  const bookings = db.prepare("SELECT * FROM bookings").all();

  for (const booking of bookings) {
    if (
      booking.reference === excludeReference ||
      !bookingBlocksSchedule(booking, now)
    ) {
      continue;
    }

    const bookingStart = localDateTimeKey(
      booking.booking_date,
      booking.booking_time
    );

    const bookingEnd = addMinutes(
      booking.booking_date,
      booking.booking_time,
      booking.hours * 60
    );

    if (startAt < bookingEnd && endAt > bookingStart) {
      return {
        type: "booking",
        reference: booking.reference,
      };
    }
  }

  const block = db.prepare(`
    SELECT id, label
    FROM availability_blocks
    WHERE ? < end_at AND ? > start_at
    LIMIT 1
  `).get(startAt, endAt);

  if (block) {
    return {
      type: "block",
      label: block.label,
    };
  }

  return null;
}

// ---------- Paystack helpers ----------

async function paystackRequest(endpoint, method = "GET", body) {
  const response = await fetch(
    `https://api.paystack.co${endpoint}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.status !== true) {
    console.error(
      "Paystack API error:",
      result.message || response.status
    );

    throw httpError(
      "Paystack could not complete the request. Please try again.",
      502
    );
  }

  return result.data;
}

function verifyWebhookSignature(rawBody, signature) {
  if (
    !Buffer.isBuffer(rawBody) ||
    typeof signature !== "string" ||
    !/^[a-f0-9]{128}$/i.test(signature)
  ) {
    return false;
  }

  const expected = crypto
    .createHmac("sha512", SECRET_KEY)
    .update(rawBody)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(signature, "hex");

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

async function verifyAndUpdateBooking(reference) {
  const initialRow = getBooking(reference);

  if (!initialRow) {
    throw httpError("Booking not found.", 404);
  }

  const transaction = await paystackRequest(
    `/transaction/verify/${encodeURIComponent(reference)}`
  );

  if (
    transaction.reference !== initialRow.reference ||
    transaction.currency !== initialRow.currency ||
    Number(transaction.amount) !== initialRow.amount_kobo
  ) {
    throw httpError(
      "Payment details do not match the booking.",
      409
    );
  }

  const now = nowIso();

  if (transaction.status === "success") {
    const result = db.transaction(() => {
      const row = getBooking(reference);

      if (!row) {
        throw httpError("Booking not found.", 404);
      }

      if (row.payment_status === "success") {
        return {
          row,
          bookingConfirmed:
            row.booking_status === "confirmed" ||
            row.booking_status === "completed",
          requiresManualReview:
            row.booking_status === "payment_review",
        };
      }

      const startAt = localDateTimeKey(
        row.booking_date,
        row.booking_time
      );

      const endAt = addMinutes(
        row.booking_date,
        row.booking_time,
        row.hours * 60
      );

      const conflict = findScheduleConflict(
        startAt,
        endAt,
        reference
      );

      const canConfirm =
        row.booking_status !== "cancelled" &&
        !conflict;

      const nextBookingStatus = canConfirm
        ? row.booking_status === "completed"
          ? "completed"
          : "confirmed"
        : "payment_review";

      const nextStatus = canConfirm
        ? "paid"
        : "paid_conflict";

      db.prepare(`
        UPDATE bookings
        SET status = ?,
            payment_status = 'success',
            booking_status = ?,
            paystack_transaction_id = ?,
            paid_at = COALESCE(paid_at, ?),
            hold_expires_at = NULL,
            updated_at = ?
        WHERE reference = ?
      `).run(
        nextStatus,
        nextBookingStatus,
        String(transaction.id),
        now,
        now,
        reference
      );

      return {
        row: getBooking(reference),
        bookingConfirmed: canConfirm,
        requiresManualReview: !canConfirm,
      };
    }).immediate();

    return {
      verified: result.row.payment_status === "success",
      booking: publicBooking(result.row),
      bookingConfirmed: result.bookingConfirmed,
      requiresManualReview: result.requiresManualReview,
      message: result.requiresManualReview
        ? "Payment was successful, but the booking needs manual review because the slot is no longer available or the booking was cancelled."
        : "Payment verified and booking confirmed.",
    };
  }

  const result = db.transaction(() => {
    const row = getBooking(reference);

    if (!row) {
      throw httpError("Booking not found.", 404);
    }

    if (row.payment_status === "success") {
      return row;
    }

    const failed = transaction.status === "failed";

    db.prepare(`
      UPDATE bookings
      SET status = ?,
          payment_status = ?,
          hold_expires_at = CASE
            WHEN ? = 1 THEN NULL
            ELSE hold_expires_at
          END,
          updated_at = ?
      WHERE reference = ?
        AND payment_status != 'success'
    `).run(
      failed ? "failed" : "pending",
      failed ? "failed" : "pending",
      failed ? 1 : 0,
      now,
      reference
    );

    return getBooking(reference);
  }).immediate();

  return {
    verified: false,
    booking: publicBooking(result),
    bookingConfirmed:
      result.booking_status === "confirmed" ||
      result.booking_status === "completed",
    requiresManualReview:
      result.booking_status === "payment_review",
    message:
      transaction.status === "failed"
        ? "Paystack reports that the payment failed."
        : "Payment has not yet succeeded.",
  };
}

// ---------- Paystack webhook ----------

// Register before express.json() to preserve the raw request body
// for Paystack's signature verification.
app.post(
  "/api/paystack/webhook",
  express.raw({
    type: "application/json",
    limit: "1mb",
  }),
  async (req, res) => {
    if (
      !verifyWebhookSignature(
        req.body,
        req.get("x-paystack-signature")
      )
    ) {
      return res.status(401).send("Invalid Paystack signature.");
    }

    let event;

    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON.");
    }

    if (
      event.event !== "charge.success" ||
      !event.data?.reference
    ) {
      return res.sendStatus(200);
    }

    try {
      await verifyAndUpdateBooking(
        String(event.data.reference)
      );

      return res.sendStatus(200);
    } catch (error) {
      console.error(
        "Webhook processing error:",
        error.message
      );

      return res.sendStatus(error.status === 404 ? 200 : 500);
    }
  }
);

app.use(express.json({ limit: "32kb" }));

// ---------- Health ----------

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Mimz Ride booking and payments",
  });
});

// ---------- Public booking and payment routes ----------

app.post("/api/payments/initialize", async (req, res) => {
  let reference;

  try {
    const body = req.body || {};

    const serviceType = normalizeServiceType(body.serviceType);
    const hours = Number(body.hours);

    if (
      !Number.isInteger(hours) ||
      hours < PRICING.minHours ||
      hours > PRICING.maxHours
    ) {
      throw httpError(
        `Booking hours must be between ${PRICING.minHours} and ${PRICING.maxHours}.`
      );
    }

    const customerName = textField(body.name, "Name", 120);
    const customerPhone = textField(body.phone, "Phone", 40);
    const customerEmail = emailField(body.email);
    const pickup = textField(
      body.pickup,
      "Pickup location",
      300
    );
    const dropoff = optionalText(body.dropoff, 300);
    const bookingDate = textField(body.date, "Booking date", 10);
    const bookingTime = textField(body.time, "Booking time", 5);
    const notes = optionalText(body.notes, 1000);

    const { startAt, endAt } = validateSchedule(
      bookingDate,
      bookingTime,
      hours
    );

    const hourlyRate =
      serviceType === "own"
        ? PRICING.rateOwn
        : PRICING.rateVeh;

    const amountNaira = hourlyRate * hours;
    const amountKobo = amountNaira * 100;

    if (
      !Number.isSafeInteger(amountKobo) ||
      amountKobo <= 0
    ) {
      throw httpError(
        "Invalid configured booking amount.",
        500
      );
    }

    const id = crypto.randomUUID();
    reference = generateReference();

    const now = nowIso();
    const holdExpiresAt = new Date(
      Date.now() + PENDING_HOLD_MINUTES * 60 * 1000
    ).toISOString();

    db.transaction(() => {
      const conflict = findScheduleConflict(startAt, endAt);

      if (conflict) {
        throw httpError(
          "This time slot is unavailable. Please choose another date or time.",
          409
        );
      }

      db.prepare(`
        INSERT INTO bookings (
          id,
          reference,
          service_type,
          hours,
          hourly_rate,
          amount_kobo,
          currency,
          customer_name,
          customer_phone,
          customer_email,
          pickup,
          dropoff,
          booking_date,
          booking_time,
          notes,
          status,
          payment_status,
          booking_status,
          hold_expires_at,
          created_at,
          updated_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'pending', 'pending', 'pending', ?, ?, ?
        )
      `).run(
        id,
        reference,
        serviceType,
        hours,
        hourlyRate,
        amountKobo,
        CURRENCY,
        customerName,
        customerPhone,
        customerEmail,
        pickup,
        dropoff,
        bookingDate,
        bookingTime,
        notes,
        holdExpiresAt,
        now,
        now
      );
    }).immediate();

    const checkout = await paystackRequest(
      "/transaction/initialize",
      "POST",
      {
        email: customerEmail,
        amount: String(amountKobo),
        currency: CURRENCY,
        reference,
        callback_url: `${FRONTEND_URL}/?payment=return`,
        metadata: {
          booking_id: id,
          service_type: serviceType,
          hours,
        },
      }
    );

    res.json({
      authorizationUrl: checkout.authorization_url,
      reference,
      amount: amountNaira,
      currency: CURRENCY,
    });
  } catch (error) {
    if (reference) {
      db.prepare(`
        UPDATE bookings
        SET status = 'failed',
            payment_status = 'failed',
            hold_expires_at = NULL,
            updated_at = ?
        WHERE reference = ?
          AND payment_status = 'pending'
      `).run(nowIso(), reference);
    }

    console.error(
      "Initialization error:",
      error.message
    );

    res.status(error.status || 500).json({
      error: error.message || "Unable to initialize payment.",
    });
  }
});

app.get(
  "/api/payments/verify/:reference",
  async (req, res) => {
    try {
      const reference = String(req.params.reference || "");

      if (!/^MIMZ-[A-Fa-f0-9]{32}$/.test(reference)) {
        throw httpError("Invalid payment reference.");
      }

      res.json(await verifyAndUpdateBooking(reference));
    } catch (error) {
      console.error(
        "Verification error:",
        error.message
      );

      res.status(error.status || 502).json({
        error: error.message || "Unable to verify payment.",
      });
    }
  }
);

app.get("/api/bookings/:reference", (req, res) => {
  const row = getBooking(String(req.params.reference));

  if (!row) {
    return res.status(404).json({
      error: "Booking not found.",
    });
  }

  res.json(publicBooking(row));
});

// ---------- Administrator authentication ----------

app.use("/api/admin", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function requireAdmin(req, res, next) {
  if (!req.session?.adminAuthenticated) {
    return res.status(401).json({
      error: "Administrator login required.",
    });
  }

  next();
}

function requireCsrf(req, res, next) {
  const supplied = req.get("x-csrf-token");
  const expected = req.session?.csrfToken;

  if (
    typeof supplied !== "string" ||
    typeof expected !== "string" ||
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(
      Buffer.from(supplied),
      Buffer.from(expected)
    )
  ) {
    return res.status(403).json({
      error: "Security token invalid or expired. Refresh the dashboard and try again.",
    });
  }

  next();
}

// The session database is stored in DATA_DIR alongside the main DB.
// Cross-site cookies are required when Vercel and Render use different
// domains. SameSite=None requires Secure=true in production.
app.use(
  session({
    name: "mimz_admin_session",
    secret: SESSION_SECRET,
    store: new SQLiteStore({
      db: "admin-sessions.sqlite",
      dir: DATA_DIR,
      table: "sessions",
    }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: IS_PRODUCTION ? "none" : "strict",
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

app.get("/api/admin/session", (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto
      .randomBytes(32)
      .toString("hex");
  }

  res.json({
    authenticated: Boolean(req.session.adminAuthenticated),
    csrfToken: req.session.csrfToken,
  });
});

app.post(
  "/api/admin/login",
  loginLimiter,
  async (req, res, next) => {
    try {
      const password = req.body?.password;

      if (
        typeof password !== "string" ||
        password.length < 1 ||
        password.length > 1024
      ) {
        throw httpError(
          "Enter your administrator password.",
          400
        );
      }

      const matches = await bcrypt.compare(
        password,
        ADMIN_PASSWORD_HASH
      );

      if (!matches) {
        return res.status(401).json({
          error: "Invalid administrator password.",
        });
      }

      await new Promise((resolve, reject) => {
        req.session.regenerate(error =>
          error ? reject(error) : resolve()
        );
      });

      req.session.adminAuthenticated = true;
      req.session.csrfToken = crypto
        .randomBytes(32)
        .toString("hex");

      await new Promise((resolve, reject) => {
        req.session.save(error =>
          error ? reject(error) : resolve()
        );
      });

      res.json({
        authenticated: true,
        csrfToken: req.session.csrfToken,
      });
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({
          error: error.message,
        });
      }

      next(error);
    }
  }
);

app.post(
  "/api/admin/logout",
  requireAdmin,
  requireCsrf,
  (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);

      res.clearCookie("mimz_admin_session", {
        httpOnly: true,
        secure: IS_PRODUCTION,
        sameSite: IS_PRODUCTION ? "none" : "strict",
      });

      res.json({ ok: true });
    });
  }
);

// ---------- Protected dashboard data ----------

app.get(
  "/api/admin/overview",
  requireAdmin,
  (_req, res) => {
    const today = zonedNowKey().slice(0, 10);
    const currentTime = zonedNowKey();
    const now = nowIso();

    const all = db.prepare(
      "SELECT * FROM bookings"
    ).all();

    const todayBookings = all.filter(
      row => row.booking_date === today
    );

    const upcomingBookings = all.filter(row => {
      const start = localDateTimeKey(
        row.booking_date,
        row.booking_time
      );

      return (
        start >= currentTime &&
        row.booking_status !== "cancelled" &&
        row.booking_status !== "payment_review"
      );
    });

    const paid = all.filter(
      row => row.payment_status === "success"
    );

    const pending = all.filter(
      row =>
        row.payment_status === "pending" &&
        row.status !== "failed"
    );

    const paidToday = paid.filter(
      row =>
        row.paid_at &&
        row.paid_at.slice(0, 10) === today
    );

    res.json({
      today: {
        bookings: todayBookings.length,
        paid: paidToday.length,
      },
      upcomingTrips: upcomingBookings.length,
      payments: {
        successfulCount: paid.length,
        successfulAmount: paid.reduce(
          (sum, row) => sum + row.amount_kobo / 100,
          0
        ),
        pendingCount: pending.length,
        pendingAmount: pending.reduce(
          (sum, row) => sum + row.amount_kobo / 100,
          0
        ),
      },
      recentBookings: all
        .sort((a, b) =>
          b.created_at.localeCompare(a.created_at)
        )
        .slice(0, 8)
        .map(adminBooking),
      pendingHolds: all.filter(
        row =>
          row.payment_status === "pending" &&
          row.hold_expires_at &&
          row.hold_expires_at > now
      ).length,
    });
  }
);

app.get(
  "/api/admin/bookings",
  requireAdmin,
  (req, res) => {
    const status = optionalText(req.query.status, 30);
    const paymentStatus = optionalText(
      req.query.paymentStatus,
      30
    );
    const search = optionalText(
      req.query.search,
      100
    ).toLowerCase();

    let rows = db.prepare(`
      SELECT *
      FROM bookings
      ORDER BY created_at DESC
    `).all();

    if (status) {
      rows = rows.filter(
        row => row.booking_status === status
      );
    }

    if (paymentStatus) {
      rows = rows.filter(
        row => row.payment_status === paymentStatus
      );
    }

    if (search) {
      rows = rows.filter(row =>
        [
          row.reference,
          row.customer_name,
          row.customer_phone,
          row.customer_email,
          row.pickup,
          row.dropoff,
        ].some(value =>
          String(value || "")
            .toLowerCase()
            .includes(search)
        )
      );
    }

    res.json({
      bookings: rows.map(adminBooking),
    });
  }
);

app.get(
  "/api/admin/bookings/:reference",
  requireAdmin,
  (req, res) => {
    const row = getBooking(String(req.params.reference));

    if (!row) {
      return res.status(404).json({
        error: "Booking not found.",
      });
    }

    res.json({
      booking: adminBooking(row),
    });
  }
);

app.patch(
  "/api/admin/bookings/:reference/status",
  requireAdmin,
  requireCsrf,
  (req, res) => {
    try {
      const reference = String(req.params.reference);
      const row = getBooking(reference);

      if (!row) {
        return res.status(404).json({
          error: "Booking not found.",
        });
      }

      const status = req.body?.status;
      const allowed = [
        "pending",
        "confirmed",
        "completed",
        "cancelled",
      ];

      if (!allowed.includes(status)) {
        return res.status(400).json({
          error: `Status must be one of: ${allowed.join(", ")}.`,
        });
      }

      if (
        (status === "confirmed" ||
          status === "completed") &&
        row.payment_status !== "success"
      ) {
        throw httpError(
          "Only a successfully paid booking can be confirmed or completed.",
          409
        );
      }

      db.transaction(() => {
        const current = getBooking(reference);

        if (!current) {
          throw httpError("Booking not found.", 404);
        }

        if (
          status === "confirmed" ||
          status === "completed"
        ) {
          const startAt = localDateTimeKey(
            current.booking_date,
            current.booking_time
          );

          const endAt = addMinutes(
            current.booking_date,
            current.booking_time,
            current.hours * 60
          );

          const conflict = findScheduleConflict(
            startAt,
            endAt,
            reference
          );

          if (conflict) {
            throw httpError(
              conflict.type === "block"
                ? "This booking overlaps an unavailable period. Remove the block or resolve the conflict before confirming."
                : "This booking overlaps another reservation. Resolve the conflict before confirming.",
              409
            );
          }
        }

        db.prepare(`
          UPDATE bookings
          SET booking_status = ?,
              updated_at = ?
          WHERE reference = ?
        `).run(status, nowIso(), reference);
      }).immediate();

      res.json({
        booking: adminBooking(getBooking(reference)),
      });
    } catch (error) {
      res.status(error.status || 500).json({
        error: error.message ||
          "Unable to update booking status.",
      });
    }
  }
);

app.post(
  "/api/admin/bookings/:reference/verify-payment",
  requireAdmin,
  requireCsrf,
  async (req, res, next) => {
    try {
      const reference = String(req.params.reference);

      if (!/^MIMZ-[A-Fa-f0-9]{32}$/.test(reference)) {
        throw httpError("Invalid payment reference.");
      }

      res.json(await verifyAndUpdateBooking(reference));
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({
          error: error.message,
        });
      }

      next(error);
    }
  }
);

// ---------- Availability and manual blocks ----------

app.get(
  "/api/admin/availability",
  requireAdmin,
  (req, res) => {
    const from = req.query.from;
    const to = req.query.to;

    if (
      !validDate(from) ||
      !validDate(to) ||
      from > to
    ) {
      return res.status(400).json({
        error: "Provide valid from and to dates in YYYY-MM-DD format.",
      });
    }

    const nowKey = zonedNowKey();
    const now = nowIso();

    const rangeStart = `${from}T00:00`;
    const rangeEnd = addMinutes(to, "23:59", 1);

    const bookings = db.prepare(`
      SELECT *
      FROM bookings
      ORDER BY booking_date, booking_time
    `).all()
      .filter(row => {
        if (!bookingBlocksSchedule(row, now)) {
          return false;
        }

        const startAt = localDateTimeKey(
          row.booking_date,
          row.booking_time
        );

        const endAt = addMinutes(
          row.booking_date,
          row.booking_time,
          row.hours * 60
        );

        return (
          startAt < rangeEnd &&
          endAt > rangeStart
        );
      })
      .map(row => ({
        reference: row.reference,
        customerName: row.customer_name,
        serviceType: row.service_type,
        bookingDate: row.booking_date,
        bookingTime: row.booking_time,
        hours: row.hours,
        startAt: localDateTimeKey(
          row.booking_date,
          row.booking_time
        ),
        endAt: addMinutes(
          row.booking_date,
          row.booking_time,
          row.hours * 60
        ),
        bookingStatus: row.booking_status,
        paymentStatus: row.payment_status,
        isPendingHold:
          row.payment_status === "pending" &&
          Boolean(row.hold_expires_at) &&
          row.hold_expires_at > now,
      }));

    const blocks = db.prepare(`
      SELECT *
      FROM availability_blocks
      WHERE substr(start_at, 1, 10) <= ?
        AND substr(end_at, 1, 10) >= ?
      ORDER BY start_at
    `).all(to, from).map(row => ({
      id: row.id,
      label: row.label,
      startAt: row.start_at,
      endAt: row.end_at,
      createdAt: row.created_at,
    }));

    res.json({
      bookings,
      blocks,
      timeZone: TIME_ZONE,
      now: nowKey,
    });
  }
);

app.post(
  "/api/admin/availability/blocks",
  requireAdmin,
  requireCsrf,
  (req, res) => {
    try {
      const label = textField(
        req.body?.label,
        "Block label",
        120
      );

      const startDate = textField(
        req.body?.startDate,
        "Start date",
        10
      );

      const startTime = textField(
        req.body?.startTime,
        "Start time",
        5
      );

      const endDate = textField(
        req.body?.endDate,
        "End date",
        10
      );

      const endTime = textField(
        req.body?.endTime,
        "End time",
        5
      );

      if (
        !validDate(startDate) ||
        !validTime(startTime) ||
        !validDate(endDate) ||
        !validTime(endTime)
      ) {
        throw httpError(
          "Enter valid block dates and times."
        );
      }

      const startAt = localDateTimeKey(
        startDate,
        startTime
      );

      const endAt = localDateTimeKey(
        endDate,
        endTime
      );

      if (
        startAt <= zonedNowKey() ||
        endAt <= startAt
      ) {
        throw httpError(
          "The block must end after a future start time."
        );
      }

      const id = crypto.randomUUID();
      const createdAt = nowIso();

      db.transaction(() => {
        const conflict = findScheduleConflict(
          startAt,
          endAt
        );

        if (conflict) {
          if (conflict.type === "block") {
            throw httpError(
              "This period overlaps an existing unavailable block.",
              409
            );
          }

          throw httpError(
            "This period overlaps a paid booking or an active payment hold.",
            409
          );
        }

        db.prepare(`
          INSERT INTO availability_blocks (
            id,
            label,
            start_at,
            end_at,
            created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `).run(
          id,
          label,
          startAt,
          endAt,
          createdAt
        );
      }).immediate();

      res.status(201).json({
        block: {
          id,
          label,
          startAt,
          endAt,
          createdAt,
        },
      });
    } catch (error) {
      res.status(error.status || 400).json({
        error: error.message ||
          "Unable to create availability block.",
      });
    }
  }
);

app.delete(
  "/api/admin/availability/blocks/:id",
  requireAdmin,
  requireCsrf,
  (req, res) => {
    const result = db.prepare(`
      DELETE FROM availability_blocks
      WHERE id = ?
    `).run(String(req.params.id));

    if (!result.changes) {
      return res.status(404).json({
        error: "Availability block not found.",
      });
    }

    res.json({ ok: true });
  }
);

// ---------- Static site and error handling ----------

const projectRoot = path.resolve(__dirname, "..");

app.use(express.static(projectRoot));

app.get("/{*splat}", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "API route not found.",
    });
  }

  res.sendFile(
    path.join(projectRoot, "index.html"),
    error => {
      if (error) next(error);
    }
  );
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error.message === "Origin not allowed by CORS.") {
    return res.status(403).json({
      error: "Origin not allowed.",
    });
  }

  console.error("Server error:", error.message);

  res.status(error.status || 500).json({
    error: error.status
      ? error.message
      : "An unexpected server error occurred.",
  });
});

app.listen(PORT, () => {
  console.log("Mimz Ride server started.");
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`Port: ${PORT}`);
  console.log(`Public API URL: ${BASE_URL}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`Booking database: ${dbPath}`);
  console.log(`Session database directory: ${DATA_DIR}`);
  console.log(`Booking time zone: ${TIME_ZONE}`);
});
