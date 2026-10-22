# Regal Chauffeur: booking web app

A static, framework-free booking site for a chauffeur service (hourly pricing, two service types, payment step, WhatsApp contact).

## Structure
```
index.html        Page markup (hero, rates, about, how it works, booking, FAQ, footer)
css/styles.css    Design tokens (colours, fonts) and all styling, with dark mode
js/config.js      Business settings: brand, WhatsApp number, hourly rates, hour limits
js/app.js         Pricing, validation, booking summary, payment modal, WhatsApp links
```

## Run it
Open `index.html` in a browser, or serve the folder: `npx serve .`

## Customise
1. `js/config.js`: brand name, WhatsApp number (international format, no +), rates.
2. `index.html`: chauffeur name, bio, stats, experience, qualifications, contact details, social links.
3. `css/styles.css`: brand colours are the variables at the top (`--navy`, `--blue`).
4. Replace the monogram in `.portrait` with a real photo (`<img>`).

## Payment integration (required before going live)
`pay()` in `js/app.js` currently simulates a payment. For Paystack or Flutterwave:
1. Add a small backend endpoint that initialises a transaction with the amount in kobo (total x 100) and returns the checkout URL or access code.
2. Open the provider checkout from `pay()`.
3. Verify the payment server-side (webhook or verify endpoint) before marking the booking as paid.
4. Save the booking and email the chauffeur and client from the backend.
Never put secret API keys in front-end code.
