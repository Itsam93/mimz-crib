const $ = id => document.getElementById(id);
const naira = n => "₦" + n.toLocaleString("en-NG");
let hours = CONFIG.minHours;
const svc = () => document.querySelector('input[name="svc"]:checked').value;
const rate = () => svc() === "own" ? CONFIG.rateOwn : CONFIG.rateVeh;
const total = () => rate() * hours;
const svcName = () => svc() === "own" ? "Chauffeur only" : "Chauffeur and vehicle";

["q1","r1"].forEach(i => $(i).textContent = naira(CONFIG.rateOwn));
["q2","r2"].forEach(i => $(i).textContent = naira(CONFIG.rateVeh));
$("q1").textContent = naira(CONFIG.rateOwn) + " / hr";
$("q2").textContent = naira(CONFIG.rateVeh) + " / hr";
$("q3").textContent = naira(CONFIG.rateOwn * CONFIG.minHours);
$("date").min = new Date().toISOString().split("T")[0];

function fmtWhen(){
  const d = $("date").value, t = $("time").value;
  if(!d) return "Not set";
  const dt = new Date(d + "T" + (t || "00:00"));
  return dt.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}) + (t ? ", " + t : "");
}
function render(){
  $("hrs").textContent = hours + " hours";
  $("s-svc").textContent = svcName();
  $("s-rate").textContent = naira(rate()) + " / hr";
  $("s-hrs").textContent = hours + " hours";
  $("s-when").textContent = fmtWhen();
  $("s-total").textContent = naira(total());
}
$("minus").onclick = () => { hours = Math.max(CONFIG.minHours, hours - 1); render(); };
$("plus").onclick = () => { hours = Math.min(CONFIG.maxHours, hours + 1); render(); };
$("form").addEventListener("input", render);
$("form").addEventListener("change", render);

function validate(){
  const rules = {
    date: v => v ? "" : "Choose a date.",
    time: v => v ? "" : "Choose a pickup time.",
    pickup: v => v.trim() ? "" : "Enter your pickup address.",
    name: v => v.trim().length > 1 ? "" : "Enter your full name.",
    phone: v => /^[+\d][\d\s-]{7,}$/.test(v.trim()) ? "" : "Enter a valid phone number.",
    email: v => /^\S+@\S+\.\S+$/.test(v.trim()) ? "" : "Enter a valid email address."
  };
  let ok = true, first = null;
  for(const k in rules){
    const m = rules[k]($(k).value);
    $("e-" + k).textContent = m;
    $(k).setAttribute("aria-invalid", m ? "true" : "false");
    if(m){ ok = false; first = first || $(k); }
  }
  if(first) first.focus();
  return ok;
}

function bookingText(ref){
  return `Hello ${CONFIG.brand}, I have booked a chauffeur.\nRef: ${ref}\nService: ${svcName()}\nWhen: ${fmtWhen()}\nDuration: ${hours} hours\nPickup: ${$("pickup").value}\nName: ${$("name").value}`;
}
function openModal(html){ $("sheet").innerHTML = html; $("modal").classList.add("open"); const f = $("sheet").querySelector("button"); if(f) f.focus(); }
function closeModal(){ $("modal").classList.remove("open"); }

$("continue").onclick = () => {
  if(!validate()) return;
  openModal(`
    <h3 id="m-title">Confirm and pay</h3>
    <p class="sub">${svcName()} for ${hours} hours on ${fmtWhen()}.</p>
    <div class="qrow" style="color:var(--muted);border-color:var(--line)"><span>Total due</span><b style="color:var(--ink);font-size:20px">${naira(total())}</b></div>
    <div class="pay" role="radiogroup" aria-label="Payment method">
      <label><input type="radio" name="pm" checked> Card payment</label>
      <label><input type="radio" name="pm"> Bank transfer</label>
    </div>
    <button class="btn btn-primary" id="pay">Pay ${naira(total())}</button>
    <button class="btn" id="cancel">Back to booking</button>`);
  $("cancel").onclick = closeModal;
  $("pay").onclick = pay;
};

function pay(){
  const b = $("pay"); b.disabled = true; b.textContent = "Processing payment…";
  /* PAYMENT INTEGRATION POINT:
     Replace this timeout with your provider's checkout (e.g. Paystack or Flutterwave).
     Initialize the transaction on your server with amount = total() * 100 (kobo),
     open the provider's checkout, then confirm the payment on your server before
     marking the booking as paid. */
  setTimeout(() => {
    const ref = "RC-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const wa = `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(bookingText(ref))}`;
    openModal(`
      <div class="done">
        <div class="tick"><svg viewBox="0 0 24 24" fill="none" stroke-width="3"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
        <h3 id="m-title">Booking confirmed</h3>
        <p class="sub">Thank you, ${$("name").value.split(" ")[0]}. A confirmation will be sent to ${$("email").value}.</p>
        <p>Booking reference</p><div class="ref">${ref}</div>
        <a class="btn btn-primary" href="${wa}" target="_blank" rel="noopener">Send details on WhatsApp</a>
        <button class="btn" id="close">Close</button>
      </div>`);
    $("close").onclick = () => { closeModal(); $("form").reset(); hours = CONFIG.minHours; render(); window.scrollTo({top:0}); };
  }, 1600);
}
$("modal").addEventListener("click", e => { if(e.target === $("modal")) closeModal(); });
document.addEventListener("keydown", e => { if(e.key === "Escape") closeModal(); });

$("wa").href = `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent("Hello " + CONFIG.brand + ", I would like to make an enquiry.")}`;
$("fwa").href = $("wa").href;
$("yr").textContent = new Date().getFullYear();
render();
