"use strict";

const API_BASE = window.MIMZ_API_BASE || "";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  csrfToken: "",
  bookings: [],
  overview: null,
  availability: { bookings: [], blocks: [] },
  activeReference: null,
  activeView: "overview",
  searchTimer: null,
  confirmAction: null,
};

const money = value => new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  maximumFractionDigits: 0,
}).format(Number(value) || 0);

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character]));

function formatDate(value) {
  if (!value) return "—";
  const parts = String(value).slice(0, 10).split("-");
  if (parts.length !== 3) return escapeHtml(value);
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatTime(value) {
  if (!value) return "—";
  const match = String(value).match(/^(\d{2}):(\d{2})/);
  if (!match) return escapeHtml(value);

  let hour = Number(match[1]);
  const minute = match[2];
  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;

  return `${hour}:${minute} ${period}`;
}

function formatDateTime(value) {
  if (!value) return "—";
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return escapeHtml(value);
  return `${formatDate(match[1])}, ${formatTime(match[2])}`;
}

function serviceLabel(value) {
  return value === "own" ? "Chauffeur only" : "Chauffeur + vehicle";
}

function statusLabel(value) {
  const labels = {
    pending: "Pending",
    success: "Successful",
    failed: "Failed",
    paid: "Paid",
    confirmed: "Confirmed",
    completed: "Completed",
    cancelled: "Cancelled",
  };
  return labels[value] || value || "Unknown";
}

function badge(value) {
  const safe = escapeHtml(value || "unknown");
  let style = "neutral";

  if (["success", "paid"].includes(value)) style = "success";
  else if (value === "pending") style = "pending";
  else if (value === "failed" || value === "cancelled") style = value;
  else if (value === "confirmed") style = "confirmed";
  else if (value === "completed") style = "completed";

  return `<span class="badge badge-${style}">${escapeHtml(statusLabel(safe))}</span>`;
}

function showToast(message, type = "success") {
  const region = $("#toast-region");
  if (!region) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  region.appendChild(toast);

  window.setTimeout(() => toast.remove(), 4800);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const method = (options.method || "GET").toUpperCase();

  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (
    ["POST", "PATCH", "DELETE", "PUT"].includes(method) &&
    state.csrfToken &&
    !path.endsWith("/login")
  ) {
    headers.set("X-CSRF-Token", state.csrfToken);
  }

  let response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      method,
      headers,
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "Cannot reach the backend. Check that the Mimz Ride server is running."
    );
  }

  const data = await response.json().catch(() => ({}));

  if (response.status === 401 && !path.endsWith("/login") &&
      !path.endsWith("/session")) {
    showLogin();
    throw new Error("Your admin session has expired. Please sign in again.");
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }

  return data;
}

function showLogin() {
  $("#app-shell").hidden = true;
  $("#login-screen").hidden = false;
  $("#login-error").textContent = "";
  $("#admin-password").value = "";
  state.csrfToken = "";
}

function showDashboard() {
  $("#login-screen").hidden = true;
  $("#app-shell").hidden = false;
}

async function initialise() {
  try {
    const session = await api("/api/admin/session");
    state.csrfToken = session.csrfToken || "";

    if (!session.authenticated) {
      showLogin();
      return;
    }

    showDashboard();
    await loadDashboard();
  } catch (error) {
    showLogin();
    showToast(error.message, "error");
  }
}

$("#toggle-password").addEventListener("click", () => {
  const password = $("#admin-password");
  const visible = password.type === "text";

  password.type = visible ? "password" : "text";
  $("#toggle-password").textContent = visible ? "Show" : "Hide";
  $("#toggle-password").setAttribute(
    "aria-label",
    visible ? "Show password" : "Hide password"
  );
});

$("#login-form").addEventListener("submit", async event => {
  event.preventDefault();

  const button = $("#login-submit");
  const errorBox = $("#login-error");
  const password = $("#admin-password").value;

  button.disabled = true;
  button.textContent = "Signing in…";
  errorBox.textContent = "";

  try {
    const result = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });

    state.csrfToken = result.csrfToken || "";
    showDashboard();
    await loadDashboard();
    showToast("Signed in successfully.");
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Sign in securely";
  }
});

$("#logout-button").addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST" });
    showLogin();
    showToast("You have signed out.");
  } catch (error) {
    showToast(error.message, "error");
  }
});

function switchView(name) {
  const titles = {
    overview: "Overview",
    bookings: "Bookings",
    payments: "Payments",
    availability: "Availability",
  };

  if (!titles[name]) return;

  state.activeView = name;

  $$(".view").forEach(view => {
    view.classList.toggle("active", view.id === `view-${name}`);
  });

  $$(".nav-link[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === name);
  });

  $("#topbar-title").textContent = titles[name];
  $("#sidebar").classList.remove("open");

  if (name === "bookings") loadBookings();
  if (name === "payments") loadPayments();
  if (name === "availability") loadAvailability();
}

$$("[data-view]").forEach(button => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

$$("[data-goto]").forEach(button => {
  button.addEventListener("click", () => switchView(button.dataset.goto));
});

$("#mobile-menu").addEventListener("click", () => {
  $("#sidebar").classList.toggle("open");
});

$("#refresh-button").addEventListener("click", refreshCurrentView);
$("#bookings-refresh").addEventListener("click", loadBookings);
$("#payments-refresh").addEventListener("click", loadPayments);
$("#availability-refresh").addEventListener("click", loadAvailability);

async function refreshCurrentView() {
  try {
    if (state.activeView === "overview") await loadDashboard();
    else if (state.activeView === "bookings") await loadBookings();
    else if (state.activeView === "payments") await loadPayments();
    else await loadAvailability();

    showToast("Dashboard refreshed.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function loadDashboard() {
  const result = await api("/api/admin/overview");
  state.overview = result;

  $("#metric-today").textContent = result.today?.bookings ?? 0;
  $("#metric-upcoming").textContent = result.upcomingTrips ?? 0;
  $("#metric-paid").textContent = money(result.payments?.successfulAmount ?? 0);
  $("#metric-pending").textContent = money(result.payments?.pendingAmount ?? 0);
  $("#metric-paid-count").textContent =
    `${result.payments?.successfulCount ?? 0} verified transactions`;
  $("#metric-pending-count").textContent =
    `${result.payments?.pendingCount ?? 0} awaiting payment`;
  $("#recent-bookings-body").innerHTML = renderRecentBookings(
    result.recentBookings || []
  );
}

function renderRecentBookings(bookings) {
  if (!bookings.length) {
    return `<tr><td colspan="5" class="empty-cell">No bookings yet.</td></tr>`;
  }

  return bookings.map(booking => `
    <tr>
      <td>
        <strong>${escapeHtml(booking.customerName)}</strong>
        <span class="cell-sub">${escapeHtml(booking.reference)}</span>
      </td>
      <td>${escapeHtml(serviceLabel(booking.serviceType))}</td>
      <td>
        <strong>${formatDate(booking.bookingDate)}</strong>
        <span class="cell-sub">${formatTime(booking.bookingTime)}</span>
      </td>
      <td>${badge(booking.paymentStatus)}</td>
      <td><button class="table-action" data-detail="${escapeHtml(booking.reference)}">View</button></td>
    </tr>
  `).join("");
}

async function loadBookings() {
  $("#bookings-body").innerHTML =
    `<tr><td colspan="7" class="empty-cell">Loading bookings…</td></tr>`;

  const params = new URLSearchParams();
  const search = $("#booking-search").value.trim();
  const status = $("#booking-status-filter").value;
  const paymentStatus = $("#booking-payment-filter").value;

  if (search) params.set("search", search);
  if (status) params.set("status", status);
  if (paymentStatus) params.set("paymentStatus", paymentStatus);

  const result = await api(`/api/admin/bookings?${params.toString()}`);
  state.bookings = result.bookings || [];

  $("#bookings-count").textContent =
    `${state.bookings.length} matching reservation${state.bookings.length === 1 ? "" : "s"}`;

  $("#bookings-body").innerHTML = renderBookings(state.bookings);
}

function renderBookings(bookings) {
  if (!bookings.length) {
    return `<tr><td colspan="7" class="empty-cell">No matching bookings found.</td></tr>`;
  }

  return bookings.map(booking => `
    <tr>
      <td><span class="reference-text">${escapeHtml(booking.reference)}</span><span class="cell-sub">${formatDate(booking.createdAt)}</span></td>
      <td><strong>${escapeHtml(booking.customerName)}</strong><span class="cell-sub">${escapeHtml(booking.customerPhone)}</span></td>
      <td><strong>${formatDate(booking.bookingDate)} · ${formatTime(booking.bookingTime)}</strong><span class="cell-sub">${escapeHtml(serviceLabel(booking.serviceType))} · ${booking.hours} hr</span></td>
      <td><strong>${money(booking.amount)}</strong></td>
      <td>${badge(booking.paymentStatus)}</td>
      <td>${badge(booking.bookingStatus)}</td>
      <td><button class="table-action" data-detail="${escapeHtml(booking.reference)}">Manage</button></td>
    </tr>
  `).join("");
}

$("#booking-search").addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    loadBookings().catch(error => showToast(error.message, "error"));
  }, 250);
});

$("#booking-status-filter").addEventListener("change", () => {
  loadBookings().catch(error => showToast(error.message, "error"));
});

$("#booking-payment-filter").addEventListener("change", () => {
  loadBookings().catch(error => showToast(error.message, "error"));
});

async function loadPayments() {
  $("#payments-body").innerHTML =
    `<tr><td colspan="7" class="empty-cell">Loading payments…</td></tr>`;

  const result = await api("/api/admin/bookings");
  const bookings = result.bookings || [];

  const paid = bookings.filter(item => item.paymentStatus === "success");
  const pending = bookings.filter(item => item.paymentStatus === "pending");

  $("#payments-total").textContent = money(
    paid.reduce((total, item) => total + Number(item.amount || 0), 0)
  );
  $("#payments-success-count").textContent = paid.length;
  $("#payments-pending-count").textContent = pending.length;

  const query = $("#payment-search").value.trim().toLowerCase();
  const filtered = bookings.filter(item => [
    item.reference,
    item.customerName,
    item.customerEmail,
    item.transactionId,
    item.paymentStatus,
  ].some(value => String(value || "").toLowerCase().includes(query)));

  $("#payments-body").innerHTML = renderPayments(filtered);
}

function renderPayments(bookings) {
  if (!bookings.length) {
    return `<tr><td colspan="7" class="empty-cell">No matching payment records found.</td></tr>`;
  }

  return bookings.map(booking => `
    <tr>
      <td><span class="reference-text">${escapeHtml(booking.reference)}</span></td>
      <td><strong>${escapeHtml(booking.customerName)}</strong><span class="cell-sub">${escapeHtml(booking.customerEmail)}</span></td>
      <td><strong>${money(booking.amount)}</strong></td>
      <td>${booking.transactionId ? escapeHtml(booking.transactionId) : "—"}</td>
      <td>${badge(booking.paymentStatus)}</td>
      <td>${booking.paidAt ? formatDateTime(booking.paidAt) : "—"}</td>
      <td>
        ${booking.paymentStatus === "pending"
          ? `<button class="table-action" data-verify="${escapeHtml(booking.reference)}">Verify</button>`
          : `<button class="table-action" data-detail="${escapeHtml(booking.reference)}">Details</button>`}
      </td>
    </tr>
  `).join("");
}

$("#payment-search").addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    loadPayments().catch(error => showToast(error.message, "error"));
  }, 250);
});

async function verifyPayment(reference) {
  const accepted = await askConfirmation(
    "Verify payment",
    `Check the Paystack transaction for ${reference}. The server will contact Paystack directly.`
  );

  if (!accepted) return;

  try {
    const result = await api(
      `/api/admin/bookings/${encodeURIComponent(reference)}/verify-payment`,
      { method: "POST", body: JSON.stringify({}) }
    );

    showToast(
      result.verified
        ? "Payment verified successfully."
        : "Paystack reports that this payment has not succeeded.",
      result.verified ? "success" : "error"
    );

    await Promise.all([loadPayments(), loadBookings(), loadDashboard()]);

    if (state.activeReference === reference) {
      await openBooking(reference);
    }
  } catch (error) {
    showToast(error.message, "error");
  }
}

function localISODate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setDefaultAvailabilityDates() {
  const today = new Date();
  const later = new Date(today);
  later.setDate(later.getDate() + 30);

  $("#availability-from").value ||= localISODate(today);
  $("#availability-to").value ||= localISODate(later);

  $("#block-form [name=startDate]").min = localISODate(today);
  $("#block-form [name=endDate]").min = localISODate(today);
}

$("#availability-from").addEventListener("change", () => {
  $("#availability-to").min = $("#availability-from").value;
});

$("#load-availability").addEventListener("click", () => {
  loadAvailability().catch(error => showToast(error.message, "error"));
});

async function loadAvailability() {
  setDefaultAvailabilityDates();

  const from = $("#availability-from").value;
  const to = $("#availability-to").value;

  if (!from || !to || from > to) {
    showToast("Choose a valid availability date range.", "error");
    return;
  }

  $("#schedule-bookings").innerHTML =
    `<div class="empty-state">Loading schedule…</div>`;
  $("#schedule-blocks").innerHTML =
    `<div class="empty-state">Loading unavailable periods…</div>`;

  const result = await api(
    `/api/admin/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  );

  state.availability = result;

  $("#schedule-bookings").innerHTML = renderScheduleBookings(result.bookings || []);
  $("#schedule-blocks").innerHTML = renderBlocks(result.blocks || []);
}

function renderScheduleBookings(bookings) {
  if (!bookings.length) {
    return `<div class="empty-state">No bookings are currently occupying this date range.</div>`;
  }

  return bookings.map(booking => `
    <div class="schedule-item">
      <div class="schedule-time">${formatDate(booking.bookingDate)}<br>${formatTime(booking.bookingTime)}</div>
      <div class="schedule-details">
        <strong>${escapeHtml(booking.customerName)} · ${booking.hours} hr</strong>
        <p>${escapeHtml(booking.reference)}<br>${escapeHtml(serviceLabel(booking.serviceType))} · ${badge(booking.paymentStatus)}</p>
        <p>Ends at ${formatDateTime(booking.endAt)}</p>
      </div>
      <button class="table-action" data-detail="${escapeHtml(booking.reference)}">View</button>
    </div>
  `).join("");
}

function renderBlocks(blocks) {
  if (!blocks.length) {
    return `<div class="empty-state">No manual unavailable periods in this date range.</div>`;
  }

  return blocks.map(block => `
    <div class="schedule-item">
      <div class="schedule-time">${formatDate(block.startAt.slice(0, 10))}<br>${formatTime(block.startAt.slice(11, 16))}</div>
      <div class="schedule-details">
        <strong>${escapeHtml(block.label)}</strong>
        <p>Until ${formatDateTime(block.endAt)}</p>
      </div>
      <button class="table-action" data-remove-block="${escapeHtml(block.id)}">Remove</button>
    </div>
  `).join("");
}

$("#block-form").addEventListener("submit", async event => {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $("#block-submit");
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  button.disabled = true;
  button.textContent = "Checking availability…";

  try {
    await api("/api/admin/availability/blocks", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    form.reset();
    setDefaultAvailabilityDates();
    showToast("Unavailable period added.");
    await loadAvailability();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "+ Block this period";
  }
});

async function removeBlock(id) {
  const accepted = await askConfirmation(
    "Remove unavailable period",
    "This will make the blocked period available for future bookings. Continue only if the time is genuinely free."
  );

  if (!accepted) return;

  try {
    await api(`/api/admin/availability/blocks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });

    showToast("Unavailable period removed.");
    await loadAvailability();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function openBooking(reference) {
  state.activeReference = reference;
  $("#detail-overlay").hidden = false;
  $("#detail-content").innerHTML = `<div class="empty-state">Loading booking details…</div>`;

  try {
    const result = await api(`/api/admin/bookings/${encodeURIComponent(reference)}`);
    const booking = result.booking;

    $("#detail-title").textContent = booking.reference;
    $("#detail-content").innerHTML = renderBookingDetails(booking);
  } catch (error) {
    $("#detail-content").innerHTML =
      `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderBookingDetails(booking) {
  const field = (label, value) => `
    <div class="detail-field">
      <small>${escapeHtml(label)}</small>
      <strong>${escapeHtml(value || "—")}</strong>
    </div>
  `;

  const canVerify = booking.paymentStatus === "pending";
  const operationalStatuses = ["pending", "confirmed", "completed", "cancelled"];

  return `
    <div class="detail-total">
      <span>Total booking amount</span>
      <strong>${money(booking.amount)}</strong>
      <div style="margin-top:12px;display:flex;gap:7px;flex-wrap:wrap">
        ${badge(booking.paymentStatus)}
        ${badge(booking.bookingStatus)}
      </div>
    </div>

    <section class="detail-section">
      <h3>Customer details</h3>
      <div class="detail-grid">
        ${field("Full name", booking.customerName)}
        ${field("Phone number", booking.customerPhone)}
        ${field("Email address", booking.customerEmail)}
        ${field("Booking reference", booking.reference)}
      </div>
    </section>

    <section class="detail-section">
      <h3>Trip details</h3>
      <div class="detail-grid">
        ${field("Service", serviceLabel(booking.serviceType))}
        ${field("Duration", `${booking.hours} hour${booking.hours === 1 ? "" : "s"}`)}
        ${field("Booking date", formatDate(booking.bookingDate))}
        ${field("Start time", formatTime(booking.bookingTime))}
        ${field("Pickup", booking.pickup)}
        ${field("Drop-off", booking.dropoff)}
        ${field("Hourly rate", money(booking.hourlyRate))}
        ${field("Created", formatDateTime(booking.createdAt))}
      </div>
      <div class="detail-field" style="margin-top:16px">
        <small>Customer notes</small>
        <strong>${escapeHtml(booking.notes || "No additional notes.")}</strong>
      </div>
    </section>

    <section class="detail-section">
      <h3>Payment details</h3>
      <div class="detail-grid">
        ${field("Payment status", statusLabel(booking.paymentStatus))}
        ${field("Paystack transaction ID", booking.transactionId)}
        ${field("Paid at", formatDateTime(booking.paidAt))}
        ${field("Pending hold expires", formatDateTime(booking.holdExpiresAt))}
      </div>
    </section>

    <section class="detail-section detail-actions">
      <label for="detail-status">Update booking status
        <select id="detail-status">
          ${operationalStatuses.map(status => `
            <option value="${status}" ${booking.bookingStatus === status ? "selected" : ""}>${statusLabel(status)}</option>
          `).join("")}
        </select>
      </label>
      <button class="btn btn-primary" id="save-booking-status">Save booking status</button>
      ${canVerify ? `<button class="btn btn-light" id="detail-verify-payment">Verify payment with Paystack</button>` : ""}
      <p class="helper-text">Changing booking status does not issue a refund or alter the recorded payment status.</p>
    </section>
  `;
}

$("#close-details").addEventListener("click", closeBookingDetails);
$("#detail-backdrop").addEventListener("click", closeBookingDetails);

function closeBookingDetails() {
  $("#detail-overlay").hidden = true;
  state.activeReference = null;
}

$("#detail-content").addEventListener("click", async event => {
  if (event.target.id === "save-booking-status") {
    const reference = state.activeReference;
    const status = $("#detail-status").value;

    if (!reference) return;

    const accepted = await askConfirmation(
      "Update booking status",
      `Change the booking status to "${statusLabel(status)}"? Payment history will remain unchanged.`
    );

    if (!accepted) return;

    event.target.disabled = true;

    try {
      await api(
        `/api/admin/bookings/${encodeURIComponent(reference)}/status`,
        {
          method: "PATCH",
          body: JSON.stringify({ status }),
        }
      );

      showToast("Booking status updated.");
      await Promise.all([loadBookings(), loadDashboard()]);

      if (state.activeView === "payments") await loadPayments();
      if (state.activeView === "availability") await loadAvailability();

      await openBooking(reference);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      event.target.disabled = false;
    }
  }

  if (event.target.id === "detail-verify-payment") {
    const reference = state.activeReference;
    if (reference) await verifyPayment(reference);
  }
});

document.addEventListener("click", event => {
  const detailButton = event.target.closest("[data-detail]");
  const verifyButton = event.target.closest("[data-verify]");
  const removeButton = event.target.closest("[data-remove-block]");

  if (detailButton) {
    openBooking(detailButton.dataset.detail);
  } else if (verifyButton) {
    verifyPayment(verifyButton.dataset.verify);
  } else if (removeButton) {
    removeBlock(removeButton.dataset.removeBlock);
  }
});

function askConfirmation(title, message) {
  return new Promise(resolve => {
    const overlay = $("#confirm-overlay");
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    overlay.hidden = false;

    state.confirmAction = resolve;
  });
}

function finishConfirmation(result) {
  const resolve = state.confirmAction;
  state.confirmAction = null;
  $("#confirm-overlay").hidden = true;
  if (resolve) resolve(result);
}

$("#confirm-cancel").addEventListener("click", () => finishConfirmation(false));
$("#confirm-accept").addEventListener("click", () => finishConfirmation(true));

$("#confirm-overlay").addEventListener("click", event => {
  if (event.target === $("#confirm-overlay")) finishConfirmation(false);
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (!$("#confirm-overlay").hidden) finishConfirmation(false);
    else if (!$("#detail-overlay").hidden) closeBookingDetails();
    else $("#sidebar").classList.remove("open");
  }
});

setDefaultAvailabilityDates();
initialise();
