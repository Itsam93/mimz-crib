const $ = id => document.getElementById(id);


const navbar = document.querySelector("header");

function updateNavbar() {
  if (!navbar) return;

  navbar.classList.toggle("is-scrolled", window.scrollY > 20);
}

window.addEventListener("scroll", updateNavbar, { passive: true });
updateNavbar();


const naira = n =>
  "₦" + Number(n).toLocaleString("en-NG");

let hours = CONFIG.minHours;
let paymentInProgress = false;

const svc = () =>
  document.querySelector('input[name="svc"]:checked')?.value || "own";

const rate = () =>
  svc() === "own" ? CONFIG.rateOwn : CONFIG.rateVeh;

const total = () => rate() * hours;

const svcName = () =>
  svc() === "own" ? "Chauffeur only" : "Chauffeur and vehicle";

const API_BASE = "https://mimz-crib.onrender.com";

["q1", "r1"].forEach(id => {
  if ($(id)) $(id).textContent = naira(CONFIG.rateOwn);
});

["q2", "r2"].forEach(id => {
  if ($(id)) $(id).textContent = naira(CONFIG.rateVeh);
});

if ($("q1")) $("q1").textContent = naira(CONFIG.rateOwn) + " / hr";
if ($("q2")) $("q2").textContent = naira(CONFIG.rateVeh) + " / hr";
if ($("q3")) $("q3").textContent = naira(CONFIG.rateOwn * CONFIG.minHours);

if ($("date")) {
  const localDate = new Date();
  localDate.setMinutes(
    localDate.getMinutes() - localDate.getTimezoneOffset()
  );
  $("date").min = localDate.toISOString().split("T")[0];
}

function fmtWhen() {
  const d = $("date")?.value || "";
  const t = $("time")?.value || "";

  if (!d) return "Not set";

  const dt = new Date(d + "T" + (t || "00:00"));

  return (
    dt.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric"
    }) +
    (t ? ", " + t : "")
  );
}

function render() {
  if ($("hrs")) $("hrs").textContent = hours + " hours";
  if ($("s-svc")) $("s-svc").textContent = svcName();

  if ($("s-rate")) {
    $("s-rate").textContent = naira(rate()) + " / hr";
  }

  if ($("s-hrs")) $("s-hrs").textContent = hours + " hours";
  if ($("s-when")) $("s-when").textContent = fmtWhen();
  if ($("s-total")) $("s-total").textContent = naira(total());

  if ($("minus")) {
    $("minus").disabled = hours <= CONFIG.minHours;
  }

  if ($("plus")) {
    $("plus").disabled = hours >= CONFIG.maxHours;
  }
}

$("minus").onclick = () => {
  hours = Math.max(CONFIG.minHours, hours - 1);
  render();
};

$("plus").onclick = () => {
  hours = Math.min(CONFIG.maxHours, hours + 1);
  render();
};

$("form").addEventListener("input", render);
$("form").addEventListener("change", render);

function validate() {
  const rules = {
    date: v => v ? "" : "Choose a date.",
    time: v => v ? "" : "Choose a pickup time.",
    pickup: v => v.trim() ? "" : "Enter your pickup address.",
    name: v => v.trim().length > 1 ? "" : "Enter your full name.",
    phone: v =>
      /^[+\d][\d\s-]{7,}$/.test(v.trim())
        ? ""
        : "Enter a valid phone number.",
    email: v =>
      /^\S+@\S+\.\S+$/.test(v.trim())
        ? ""
        : "Enter a valid email address."
  };

  let ok = true;
  let first = null;

  for (const key in rules) {
    const field = $(key);
    const errorElement = $("e-" + key);

    if (!field) continue;

    const message = rules[key](field.value);

    if (errorElement) errorElement.textContent = message;

    field.setAttribute("aria-invalid", message ? "true" : "false");

    if (message) {
      ok = false;
      first = first || field;
    }
  }

  if (first) first.focus();

  return ok;
}

function bookingText(ref, booking = {}) {
  return [
    `Hello ${CONFIG.brand}, I have booked a chauffeur.`,
    `Ref: ${ref}`,
    `Service: ${booking.serviceType || svcName()}`,
    `When: ${booking.bookingDate || fmtWhen()}`,
    `Duration: ${booking.hours ?? hours} hours`,
    `Pickup: ${$("pickup")?.value || ""}`,
    `Drop-off: ${$("drop")?.value || ""}`,
    `Name: ${$("name")?.value || ""}`,
    `Payment: Confirmed`
  ].join("\n");
}

function openModal(html) {
  $("sheet").innerHTML = html;
  $("modal").classList.add("open");

  const firstButton = $("sheet").querySelector("button");
  if (firstButton) firstButton.focus();
}

function closeModal() {
  $("modal").classList.remove("open");
}

function showStatus(message, isError = false) {
  let status = $("payment-status");

  if (!status) {
    status = document.createElement("p");
    status.id = "payment-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    $("sheet").appendChild(status);
  }

  status.textContent = message;
  status.style.color = isError ? "#b42318" : "";
}

async function apiRequest(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || "The request could not be completed.");
  }

  return result;
}

function collectBooking() {
  return {
    serviceType: svc() === "own" ? "own" : "vehicle",
    hours,
    name: $("name").value.trim(),
    phone: $("phone").value.trim(),
    email: $("email").value.trim(),
    date: $("date").value,
    time: $("time").value,
    pickup: $("pickup").value.trim(),
    dropoff: $("drop")?.value.trim() || "",
    notes: $("notes")?.value.trim() || ""
  };
}

function setPendingReference(reference) {
  try {
    sessionStorage.setItem("mimzRidePendingReference", reference);
  } catch {
    // Verification uses the Paystack return reference.
  }
}

function clearPendingReference() {
  try {
    sessionStorage.removeItem("mimzRidePendingReference");
  } catch {
    // Ignore unavailable browser storage.
  }
}

function getReturnReference() {
  const params = new URLSearchParams(window.location.search);

  return params.get("reference") || params.get("trxref") || "";
}

function cleanReturnUrl() {
  const url = new URL(window.location.href);

  url.searchParams.delete("payment");
  url.searchParams.delete("reference");
  url.searchParams.delete("trxref");

  window.history.replaceState(
    {},
    document.title,
    url.pathname + url.search + url.hash
  );
}

function showBookingConfirmation(booking) {
  const firstName =
    $("name").value.trim().split(/\s+/)[0] || "there";

  const reference = booking.reference;
  const paidAmount = naira(booking.amount);

  const wa = `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(
    bookingText(reference, booking)
  )}`;

  openModal(`
    <div class="done">
      <div class="tick">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="3">
          <path d="M5 12.5l4.5 4.5L19 7.5"/>
        </svg>
      </div>

      <h3 id="m-title">Booking confirmed</h3>

      <p class="sub">
        Thank you, ${escapeHtml(firstName)}.
        Your payment of ${paidAmount} has been verified.
      </p>

      <p>Booking reference</p>
      <div class="ref">${escapeHtml(reference)}</div>

      <p>Service: ${escapeHtml(booking.serviceType === "own"
        ? "Chauffeur only"
        : "Chauffeur and vehicle")}</p>

      <p>Duration: ${Number(booking.hours)} hours</p>

      <p>Payment status: Confirmed</p>

      <a class="btn btn-primary"
         href="${wa}"
         target="_blank"
         rel="noopener noreferrer">
        Send details on WhatsApp
      </a>

      <button class="btn" id="close">Close</button>
    </div>
  `);

  $("close").onclick = () => {
    closeModal();
    $("form").reset();
    hours = CONFIG.minHours;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  document.dispatchEvent(
    new CustomEvent("mimzride:payment-confirmed", {
      detail: booking
    })
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

async function pay() {
  if (paymentInProgress) return;

  if (!validate()) {
    closeModal();
    return;
  }

  const button = $("pay");
  const originalText = button?.textContent;

  paymentInProgress = true;

  if (button) {
    button.disabled = true;
    button.textContent = "Connecting to secure checkout…";
  }

  try {
    const booking = collectBooking();

    // No amount is sent from the browser.
    // The server calculates it using RATE_OWN / RATE_VEH and hours.
    const result = await apiRequest("/api/payments/initialize", {
      method: "POST",
      body: JSON.stringify(booking)
    });

    if (!result.authorizationUrl || !result.reference) {
      throw new Error("Paystack did not return a checkout URL.");
    }

    setPendingReference(result.reference);

    // The customer pays on Paystack's hosted checkout page.
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    paymentInProgress = false;

    if (button) {
      button.disabled = false;
      button.textContent = originalText || `Pay ${naira(total())}`;
    }

    showStatus(
      error.message || "Unable to initialize payment. Please try again.",
      true
    );
  }
}

$("continue").onclick = () => {
  if (!validate()) return;

  const booking = collectBooking();

  openModal(`
    <h3 id="m-title">Confirm and pay</h3>

    <p class="sub">
      ${escapeHtml(svcName())} for ${hours} hours on
      ${escapeHtml(fmtWhen())}.
    </p>

    <div class="qrow"
         style="color:var(--muted);border-color:var(--line)">
      <span>Total due</span>
      <b style="color:var(--ink);font-size:20px">
        ${naira(total())}
      </b>
    </div>

    <p class="sub">
      You will be redirected to Paystack's secure checkout.
    </p>

    <button class="btn btn-primary" id="pay">
      Pay ${naira(total())}
    </button>

    <button class="btn" id="cancel">
      Back to booking
    </button>
  `);

  $("cancel").onclick = closeModal;
  $("pay").onclick = pay;
};

async function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);

  if (
    params.get("payment") !== "return" &&
    !getReturnReference()
  ) {
    return;
  }

  const reference = getReturnReference();

  if (!reference) {
    openModal(`
      <h3 id="m-title">Payment verification needed</h3>
      <p class="sub">
        We could not find the payment reference.
        If you completed payment, contact Mimz Ride for assistance.
      </p>
      <button class="btn" id="close">Close</button>
    `);

    $("close").onclick = closeModal;
    return;
  }

  openModal(`
    <h3 id="m-title">Verifying payment</h3>
    <p class="sub" id="verification-message" role="status">
      Please wait while we verify your transaction with Paystack.
    </p>
  `);

  try {
    const result = await apiRequest(
      `/api/payments/verify/${encodeURIComponent(reference)}`
    );

    if (
      result.verified === true &&
      result.booking?.status === "paid" &&
      result.booking?.paymentStatus === "success"
    ) {
      clearPendingReference();
      cleanReturnUrl();
      showBookingConfirmation(result.booking);
      return;
    }

    $("sheet").innerHTML = `
      <h3 id="m-title">Payment not confirmed yet</h3>
      <p class="sub">
        We could not confirm a successful payment.
        Do not make another payment immediately.
      </p>
      <p>Reference: ${escapeHtml(reference)}</p>
      <button class="btn btn-primary" id="retry-verification">
        Retry verification
      </button>
      <button class="btn" id="close">Close</button>
    `;

    $("retry-verification").onclick = () => {
      handlePaymentReturn();
    };

    $("close").onclick = closeModal;
  } catch (error) {
    $("sheet").innerHTML = `
      <h3 id="m-title">Unable to verify payment</h3>
      <p class="sub">
        ${escapeHtml(error.message)}
      </p>
      <p>Keep your payment reference for assistance.</p>
      <div class="ref">${escapeHtml(reference)}</div>
      <button class="btn btn-primary" id="retry-verification">
        Retry verification
      </button>
      <button class="btn" id="close">Close</button>
    `;

    $("retry-verification").onclick = () => {
      handlePaymentReturn();
    };

    $("close").onclick = closeModal;
  }
}

$("modal").addEventListener("click", event => {
  if (event.target === $("modal")) closeModal();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeModal();
});

if ($("wa")) {
  $("wa").href =
    `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(
      "Hello " + CONFIG.brand + ", I would like to make an enquiry."
    )}`;
}

if ($("fwa") && $("wa")) {
  $("fwa").href = $("wa").href;
}

if ($("yr")) {
  $("yr").textContent = new Date().getFullYear();
}

render();

// Process Paystack's return URL after the page has loaded.
handlePaymentReturn();



