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

## 2. Amazon order automation (currently paused)

This section describes `scripts/sync-orders.js` and `scripts/confirm-shipment.js`, which call Amazon's SP-API directly to track and confirm FBM orders. **These need your own Amazon developer (LWA) credentials, which aren't available right now** — so their schedules are paused (see the comments at the top of each workflow file). Veeqo's own dashboard already shows your Amazon orders, FBA and FBM alike, since it's connected to your Amazon account — use that for day-to-day order tracking instead.

If you ever do get LWA credentials (registering a developer app in Seller Central → Apps & Services → Develop Apps), here's what they enable:

- `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, `LWA_REFRESH_TOKEN` (the refresh token comes from authorizing the app against your seller account) as repo secrets re-enable **Sync Amazon Orders** (opens a GitHub Issue per unshipped order) and **Confirm Amazon Shipment** (manual workflow to mark an order shipped with tracking info). Uncomment the `schedule:` block in `sync-orders.yml` once these are set.

### Before relying on this for real orders

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

### Fulfillment: Veeqo, not direct Amazon access

Getting your own Amazon SP-API developer credentials (LWA) requires registering a developer app in Seller Central — a real hurdle if you're not building software for a living. Since Veeqo already has a connection to your Amazon account (the "Continue with Amazon" you set up earlier), this uses Veeqo's API instead for both inventory and fulfillment. Veeqo routes fulfillment to Amazon's Multi-Channel Fulfillment (MCF) on your behalf — you never touch Amazon's developer side at all.

1. **Get a Veeqo API key**: in the Veeqo app, go to your user (or create a "+ New Employee" if you want a dedicated one for this integration) → look for an API Key section → generate one. If you don't see that option, message Veeqo support (helpme@support.veeqo.com or the in-app chat) and ask them to enable API access on your account first — this is a quick request, not a developer application process.
2. **Make sure all 3 products exist in Veeqo's own catalog** with the SKUs matching exactly: `FV-LNLR-DPRX`, `IT-3U6C-E8HZ`, `LOL1A`. If Veeqo pulled your Amazon listings in automatically when you connected it, they're probably already there — check Inventory in the Veeqo app.
3. **Make sure at least one delivery method exists** in Veeqo (Settings → Delivery Methods) — any one is fine, the setup script below just grabs the first one it finds.
4. Add `VEEQO_API_KEY` as a Cloudflare secret (same place as the others), plus a new one called `ADMIN_SETUP_KEY` — make up any random password-like string for this one, it's just there to stop strangers from triggering setup.
5. Once deployed, visit `https://<your-site>/api/admin/setup-veeqo?key=<whatever you set ADMIN_SETUP_KEY to>` in your browser. This is a one-time step (safe to re-run) that links your 3 products to a special "Amazon fulfillment" channel inside Veeqo. You'll see a plain-text log confirming what it did — if a SKU shows "NOT FOUND," it means step 2 still needs doing.
6. **Important — shipping speed**: customers now choose between Standard (free) and Expedited (+$5) right on Stripe's checkout page. That same setup-veeqo log lists every delivery method configured in your Veeqo account (id, name, carrier). In Veeqo's own dashboard, check **Settings → Marketplace and Integrations** → your "Website (Custom Integration)" channel for whatever setting maps delivery methods to Amazon MCF shipping speed, and confirm which listed id corresponds to **Standard** and which to **Expedited**. Once confirmed, add two Cloudflare secrets:
   - `VEEQO_DELIVERY_METHOD_ID_STANDARD`
   - `VEEQO_DELIVERY_METHOD_ID_EXPEDITED`

   Checkout will fail with a clear error for whichever speed isn't set yet — that's intentional, so a missing mapping can't silently ship at the wrong speed/cost.
6. Also add `VEEQO_API_KEY` as a **GitHub** repo secret (Settings → Secrets and variables → Actions) — `sync-inventory.js` needs it there too, to keep the site's stock display current.

One honest caveat: I built this against Veeqo's published API docs but can't call their API directly to test it from where I'm working, so a couple of field names (exactly how stock totals come back, the order-creation shape) are my best reading of their docs rather than something I've verified live. Worth keeping an eye on the Cloudflare deployment logs after your first real test order, in case a field name needs a small adjustment.

**What this means for the earlier Amazon-order-tracking automation**: `sync-orders.yml` (GitHub Issues per unshipped order) and `confirm-shipment.yml` both call Amazon's SP-API directly too, so they're paused for the same reason — and honestly, Veeqo's own dashboard already does that job, since it can see all your Amazon orders (FBA and FBM) natively. Worth just using Veeqo for that day-to-day work instead.

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
   - `VEEQO_API_KEY`
   - `ADMIN_SETUP_KEY` (any random string you make up)
   - `SITE_URL` — your `.workers.dev` URL for testing, swap to `https://lolemons.com` once on a custom domain
3. Push/merge triggers a redeploy automatically (Workers Builds, Cloudflare's built-in CI). Check the Deployments tab for build logs if something doesn't show up.

### Supabase
- In the `inventory` table (already created by `supabase/schema.sql`), set `stripe_price_id` for each SKU row to the matching Stripe Price ID from above. `sync-inventory.js` will create the rows automatically on its first run (stock quantity only) — you just need to fill in the price ID column once per SKU.

### What happens once it's all connected
- `sync-inventory.js` (every 10 min) keeps Supabase's stock count in sync with real FBA inventory.
- A customer clicks **Buy Now** on `products.html` → `src/worker.js` atomically reserves stock and hands back a Stripe Checkout URL → they pay on Stripe's hosted page.
- Stripe calls the webhook route on success → records the order in `dtc_orders`, consumes the reservation, and creates an order in Veeqo on a dedicated "Amazon fulfillment" channel — Veeqo then routes it to FBA via MCF on your behalf.
- If they abandon checkout, the reservation expires after 15 minutes and the stock becomes available again automatically.

### Before trusting this with real money
- Test the full flow with [Stripe test mode](https://docs.stripe.com/test-mode) and a test card before flipping to live keys.
- The order-creation shape in `src/lib/veeqo.js` follows Veeqo's published docs, but I haven't been able to call their API directly to verify it live — double-check the response after your first real test order, and adjust field names if anything comes back unexpected.
- If `npm install` fails on the `stripe` package version pinned in `package.json`, bump it to whatever's current on [npmjs.com/package/stripe](https://www.npmjs.com/package/stripe).



## File map

```
index.html, products.html, about.html, contact.html, success.html   — the site
css/styles.css, js/main.js, js/subscribe.js, js/buy.js   — styles + small JS + newsletter + checkout UI
wrangler.jsonc                                            — Cloudflare Worker config (assets + routing)
.assetsignore                                             — keeps source/server files out of the public site
src/worker.js                                             — Worker entry: routes /api/* , serves everything else as static
src/lib/sb.js, src/lib/veeqo.js                           — shared helpers for the above (Workers runtime)
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
# Trigger redeploy: confirm latest env vars (ADMIN_SETUP_KEY, etc.) are picked up
# Verify: Branch Control now correctly points to main (was claude/website-revamp)
# Trigger rebuild: confirm SITE_URL env var is picked up after adding it
