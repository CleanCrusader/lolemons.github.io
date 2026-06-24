# Lots of Lemon — site + Amazon FBM automation

Two independent pieces in this repo:

1. **The public site** (`index.html`, `products.html`, `about.html`, `contact.html`, `css/`, `js/`) — static HTML, deploys straight to GitHub Pages, no build step.
2. **Amazon order automation** (`scripts/`, `.github/workflows/`) — runs entirely inside GitHub Actions, not on the public site. This is what talks to the Selling Partner API (SP-API) to pull new FBM orders and confirm shipments.

These are split deliberately: GitHub Pages only serves static files, and your Amazon refresh token / client secret must never end up in anything a browser loads. Actions secrets are encrypted and only readable by workflow runs — never by site visitors.

## 1. Deploy the site

1. Push this repo to GitHub.
2. Repo **Settings → Pages** → Source: "Deploy from a branch" → pick `main` (or whichever branch) and `/ (root)`.
3. Your site will be live at `https://<your-username>.github.io/<repo-name>/` (or your custom domain, if you add a `CNAME` file).

Product photos live in `/images` (carried over from the previous version of this repo). Swap in higher-res or additional shots there whenever you have them — just update the `src` attributes in `index.html` / `products.html` to match.

The contact form posts to [Formspree](https://formspree.io) (a free form backend, since GitHub Pages has no server). Sign up, create a form, and replace `YOUR_FORM_ID` in `contact.html` with your real form ID. Until you do that, the direct email link on the same page still works.

## 2. Set up Amazon order automation

You said you already have SP-API credentials. You'll need three values from your Login with Amazon (LWA) app in Seller Central → Apps & Services → Develop Apps:

- `LWA_CLIENT_ID`
- `LWA_CLIENT_SECRET`
- `LWA_REFRESH_TOKEN` (generated when you authorized the app against your seller account)

Add these as **repository secrets**: repo **Settings → Secrets and variables → Actions → New repository secret**.

If you sell outside the US marketplace, also add a repository **variable** (not secret) called `SPAPI_MARKETPLACE_ID` with the right marketplace ID (see `MARKETPLACE_IDS` in `scripts/spapi-client.js` for a few common ones, or look yours up in the SP-API docs).

### What the two workflows do

- **Sync Amazon Orders** (`.github/workflows/sync-orders.yml`) — runs every 15 minutes, asks Amazon for unshipped FBM orders from the last 48 hours, and opens a GitHub Issue (labeled `amazon-order`, `needs-fulfillment`) for each new one. This is your order inbox — no database needed.
- **Confirm Amazon Shipment** (`.github/workflows/confirm-shipment.yml`) — manual only. Go to the **Actions** tab → "Confirm Amazon Shipment" → "Run workflow", fill in the order ID + carrier + tracking number, and it marks the order shipped on Amazon.

Both run as plain Node scripts (`scripts/sync-orders.js`, `scripts/confirm-shipment.js`) against a small shared client (`scripts/spapi-client.js`) that handles the LWA token exchange. No AWS SigV4 signing needed — Amazon dropped that requirement in October 2023.

### Before you rely on this for real orders

The `confirmShipment` request body in `scripts/confirm-shipment.js` follows Amazon's documented shape, but Amazon has changed nested field names across API versions before. **Test it against the [SP-API sandbox](https://developer-docs.amazon.com/sp-api/docs/sandbox-environments) first**, and run "Confirm Amazon Shipment" once against a real low-stakes order before trusting it on a busy day.

Two things this version deliberately doesn't do, which you may want to add later:

- **Buyer name/address isn't pulled into the GitHub Issue.** Amazon requires a Restricted Data Token (Tokens API) to fetch PII, which adds a step. Get the address from Seller Central for now, or extend `sync-orders.js` if you want it inline.
- **No shipping-label purchase.** This confirms shipment with a tracking number you already have (e.g. from Pirate Ship, ShipStation, or buying postage directly). If you want Amazon to generate the label too, look at the Merchant Fulfillment API (`createShipment`) — a logical next step, not included here.

## File map

```
index.html, products.html, about.html, contact.html   — the site
css/styles.css, js/main.js                             — styles + small JS
scripts/spapi-client.js                                 — shared SP-API client
scripts/sync-orders.js                                  — order → GitHub Issue
scripts/confirm-shipment.js                              — mark order shipped
.github/workflows/sync-orders.yml                        — scheduled job
.github/workflows/confirm-shipment.yml                   — manual job
```
