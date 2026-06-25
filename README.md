# Lots of Lemon — site + Amazon FBM automation

Two independent pieces in this repo:

1. **The public site** (`index.html`, `products.html`, `about.html`, `contact.html`, `css/`, `js/`) — static HTML, deploys straight to GitHub Pages, no build step.
2. **Amazon order automation** (`scripts/`, `.github/workflows/`) — runs entirely inside GitHub Actions, not on the public site. This is what talks to the Selling Partner API (SP-API) to pull new FBM orders and confirm shipments.

These are split deliberately: GitHub Pages only serves static files, and your Amazon refresh token / client secret must never end up in anything a browser loads. Actions secrets are encrypted and only readable by workflow runs — never by site visitors.

## 1. Deploy the site

1. Push this repo to GitHub.
2. Repo **Settings → Pages** → Source: "Deploy from a branch" → pick `main` (or whichever branch) and `/ (root)`.
3. Your site will be live at `https://<your-username>.github.io/<repo-name>/` (or your custom domain, if you add a `CNAME` file).

Swap in your own product photography when you have it — the pages currently hotlink your existing bottle photos from lolemons.com as placeholders (`<img src="https://lolemons.com/...">`). For a permanent setup, save real images into an `/images` folder in this repo and update the `src` attributes.

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

## 3. Set up the customer database (Supabase)

Two separate tables, two separate purposes — see `supabase/schema.sql` for the full reasoning:

- **`orders`** — operational fulfillment records (name/address) pulled from Amazon. Per Amazon policy, PII here gets auto-purged ~30 days after shipment by the daily purge job. No public access at all.
- **`subscribers`** — your opt-in marketing list, populated only by people signing up on the site itself, never from Amazon order data.

Setup:

1. In the Supabase SQL Editor, paste and run all of `supabase/schema.sql` once.
2. Add two more repository secrets (same place as the LWA ones): `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (from Project Settings → API). The service_role key bypasses Row Level Security, so it must never appear in any file in this repo — secrets only.
3. The site's newsletter signup (in the footer of every page) already has the project URL and **anon** key hardcoded in `js/subscribe.js`. That's intentional and safe — the anon key can only INSERT into `subscribers`, nothing else, enforced by the RLS policy in the schema. If you ever rotate that key in Supabase, update it there too.

### How the pieces fit together now

- **`sync-orders.js`** (every 15 min) — pulls any FBM order that changed recently (new, shipped, or canceled — no matter *how* it shipped), upserts it into the `orders` table, and keeps a GitHub Issue per order needing fulfillment, auto-closing it once Amazon shows the order as shipped.
- **`confirm-shipment.js`** (manual, Actions tab) — a fallback for anything shipped outside Veeqo/Seller Central's normal flow; also updates the Supabase record.
- **`purge-old-pii.js`** (daily) — nulls out name/address on any order past its 30-day retention window.
- **Veeqo** (if you've connected it) — handles the actual day-to-day "pull order → buy label → ship" workflow with Amazon's negotiated carrier rates, and confirms shipment with Amazon directly. `sync-orders.js` will notice that status change on its next run regardless of where it came from.



## 4. Set up direct checkout (Stripe + Cloudflare Workers + FBA fulfillment)

This is the biggest piece: customers can now buy straight from lolemons.com, paid via Stripe, shipped from your FBA stock via Amazon's Multi-Channel Fulfillment (MCF). It needs a few accounts wired together. Do these roughly in order:

### Amazon side
- Confirm your Seller Central account has API/MCF access (you're already on FBA, so no new signup is needed for MCF itself, but double check your SP-API app has the **Product Listing** role for inventory reads — no Restricted Data Token needed, stock counts aren't PII).
- Real seller SKUs are already wired in for all three products (`FV-LNLR-DPRX`, `IT-3U6C-E8HZ`, `LOL1A`).

### Stripe
1. Create a Stripe account (or use an existing one) at stripe.com.
2. Product catalog → create one Product per SKU, each with a one-time Price. Note each Price ID (`price_...`).
3. Developers → Webhooks → add an endpoint pointing at `https://yourdomain.com/api/stripe-webhook`, subscribed to `checkout.session.completed` and `checkout.session.expired`. Note the **signing secret** (`whsec_...`).
4. Note your **secret key** (`sk_...`) from Developers → API keys. Don't paste this in chat — it goes straight into Cloudflare's secret store (next section).

### Cloudflare Workers (not classic "Pages")
Cloudflare is consolidating Pages into Workers — connecting a repo through the dashboard today creates a **Worker with static assets**, not a classic Pages project, and it does *not* auto-detect a `/functions` folder the way Pages used to. This repo is set up for that model directly:

- `wrangler.jsonc` — the Worker config: serves everything in the repo as static assets *except* what's listed in `.assetsignore` (source/server files), and routes `/api/*` specifically to `src/worker.js` via `run_worker_first` — everything else is served as a static file without invoking any Worker code at all.
- `src/worker.js` — the single entry point handling both `/api/create-checkout-session` and `/api/stripe-webhook`.

Setup:
1. Workers & Pages → your project → **Settings → Build** (or Git settings) → confirm/set the connected branch. **This matters a lot**: whichever branch is connected is what actually deploys — if it's `main`, it won't reflect anything in this PR until merged.
2. Settings → **Variables and Secrets** → add these as **Secret** type (do this for both Production and Preview environments if shown separately):
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, `LWA_REFRESH_TOKEN`
   - `SITE_URL` — your `.workers.dev` URL for testing, swap to `https://lolemons.com` once on a custom domain
   - `SPAPI_MARKETPLACE_ID` (optional, defaults to US)
3. Push/merge triggers a redeploy automatically (Workers Builds, Cloudflare's built-in CI). Check the Deployments tab for build logs if something doesn't show up.

### Supabase
- In the `inventory` table (already created by `supabase/schema.sql`), set `stripe_price_id` for each SKU row to the matching Stripe Price ID from above. `sync-inventory.js` will create the rows automatically on its first run (stock quantity only) — you just need to fill in the price ID column once per SKU.

### What happens once it's all connected
- `sync-inventory.js` (every 10 min) keeps Supabase's stock count in sync with real FBA inventory.
- A customer clicks **Buy Now** on `products.html` → `src/worker.js` atomically reserves stock and hands back a Stripe Checkout URL → they pay on Stripe's hosted page.
- Stripe calls the webhook route on success → records the order in `dtc_orders`, consumes the reservation, and calls Amazon's `createFulfillmentOrder` to ship it from FBA stock.
- If they abandon checkout, the reservation expires after 15 minutes and the stock becomes available again automatically.

### Before trusting this with real money
- Test the full flow with [Stripe test mode](https://docs.stripe.com/test-mode) and a test card before flipping to live keys.
- The `createFulfillmentOrder` field names in `functions/api/stripe-webhook.js` follow Amazon's documented shape, but double-check them against the current [SP-API reference](https://developer-docs.amazon.com/sp-api/reference/createfulfillmentorder) / sandbox before going live — Amazon has reshaped this schema before.
- If `npm install` fails on the `stripe` package version pinned in `package.json`, bump it to whatever's current on [npmjs.com/package/stripe](https://www.npmjs.com/package/stripe).



## File map

```
index.html, products.html, about.html, contact.html, success.html   — the site
css/styles.css, js/main.js, js/subscribe.js, js/buy.js   — styles + small JS + newsletter + checkout UI
wrangler.jsonc                                            — Cloudflare Worker config (assets + routing)
.assetsignore                                             — keeps source/server files out of the public site
src/worker.js                                             — Worker entry: routes /api/* , serves everything else as static
src/lib/lwa.js, src/lib/sb.js                             — shared helpers for the above (Workers runtime)
scripts/spapi-client.js                                   — shared SP-API client (Node/Actions runtime)
scripts/supabase-client.js                                 — shared Supabase REST client (server-side)
scripts/sync-orders.js                                    — order changes → Supabase + GitHub Issues
scripts/sync-inventory.js                                 — FBA stock → Supabase inventory table
scripts/confirm-shipment.js                                — manual fallback: mark order shipped
scripts/purge-old-pii.js                                  — daily PII retention cleanup
supabase/schema.sql                                        — run once in the Supabase SQL Editor
.github/workflows/sync-orders.yml                          — scheduled job
.github/workflows/sync-inventory.yml                       — scheduled job
.github/workflows/confirm-shipment.yml                     — manual job
.github/workflows/purge-pii.yml                            — daily job
```
