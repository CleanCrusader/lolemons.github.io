// scripts/sync-prices-amazon.js
//
// Reads each product's CURRENT selling price directly from Amazon via the
// official Selling Partner API (Product Pricing v0), then:
//   1. Creates a new Stripe Price (prices are immutable — this is the
//      standard way to change one) and sets it as the product's default.
//   2. Updates Supabase inventory (price + stripe_price_id).
//   3. Commits the new price into products.html (visible tag + structured
//      data) directly to the branch.
//
// This replaces the Veeqo-based price reader. It uses your own authorized
// SP-API access — no scraping (which would violate Amazon's ToS and risk
// the seller account).
//
// Env: SPAPI_* (via spapi-client), STRIPE_SECRET_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY.
//
// Default is DRY RUN (logs only, changes nothing). Set APPLY=true to make
// real changes.

import Stripe from "stripe";
import { spapiFetch, MARKETPLACE_IDS } from "./spapi-client.js";
import { upsert, select } from "./supabase-client.js";

const APPLY = process.env.APPLY === "true";
const MARKETPLACE_ID = MARKETPLACE_IDS.US;

// SKU -> ASIN. Keep in sync with src/worker.js.
const SKU_TO_ASIN = {
  "FV-LNLR-DPRX": "B0DF5Y13MZ",
  "IT-3U6C-E8HZ": "B0C14RYXK2",
  "LOL1A": "B08JQFG63X",
};

const SKU_TO_SLUG = {
  "FV-LNLR-DPRX": "clean-crusader-24oz",
  "IT-3U6C-E8HZ": "clean-crusader-concentrate",
  "LOL1A": "pet-odor-eliminator",
};

let _stripe;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// Reads the current price for one ASIN via Product Pricing v0.
async function fetchAmazonPrice(asin) {
  const path = `/products/pricing/v0/price?MarketplaceId=${MARKETPLACE_ID}&Asins=${asin}&ItemType=Asin`;
  const res = await spapiFetch(path);
  // Response shape: { payload: [ { ASIN, Product: { Offers: [...] } } ] }
  const entry = res?.payload?.find((p) => p.ASIN === asin) || res?.payload?.[0];
  const offers = entry?.Product?.Offers || [];
  // Prefer the seller's own offer; fall back to first landed price.
  for (const o of offers) {
    const amt = o?.BuyingPrice?.ListingPrice?.Amount;
    if (amt != null) return Number(amt);
  }
  return null;
}

async function updateStripePrice(stripeProductId, sku, newPrice) {
  const stripe = getStripe();
  const price = await stripe.prices.create({
    product: stripeProductId,
    currency: "usd",
    unit_amount: Math.round(newPrice * 100),
  });
  await stripe.products.update(stripeProductId, { default_price: price.id });
  console.log(`${sku}: created Stripe price ${price.id} ($${newPrice})`);
  return price.id;
}

function updateProductsHtml(html, changes) {
  let out = html;
  for (const [sku, price] of changes) {
    const slug = SKU_TO_SLUG[sku];
    if (!slug) continue;
    const p = price.toFixed(2);
    // Visible price tag: <span class="product-price">$9.99</span> inside the card
    // Structured data: "price": "9.99"
    // Both are updated by anchoring on the slug's product block is complex;
    // instead update the structured-data price by SKU and the visible tag by slug id.
    // Structured data (keyed by #slug in @id):
    out = out.replace(
      new RegExp(`("@id":\\s*"https://lolemons.com/products.html#${slug}"[\\s\\S]*?"price":\\s*")[0-9.]+(")`),
      `$1${p}$2`
    );
    // Visible tag inside the product card (id="slug" ... first product-price)
    out = out.replace(
      new RegExp(`(id="${slug}"[\\s\\S]*?<span class="product-price">\\$)[0-9.]+(</span>)`),
      `$1${p}$2`
    );
  }
  return out;
}

async function commitProductsHtml(html, sha, branch, repo) {
  const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" };
  const body = {
    message: "Auto: sync product prices from Amazon",
    content: Buffer.from(html, "utf-8").toString("base64"),
    sha,
    branch,
  };
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/products.html`, {
    method: "PUT", headers, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub commit failed (${res.status}): ${await res.text()}`);
}

async function main() {
  console.log(APPLY ? "=== APPLY MODE: will make real changes ===" : "=== DRY RUN: logging only, no changes ===");

  const existing = await select("inventory", {}, "sku,price,stripe_product_id,stripe_price_id");
  const existingBySku = new Map(existing.map((r) => [r.sku, r]));
  const changes = new Map();

  for (const [sku, asin] of Object.entries(SKU_TO_ASIN)) {
    let amazonPrice;
    try {
      amazonPrice = await fetchAmazonPrice(asin);
    } catch (err) {
      console.error(`${sku} (${asin}): price fetch failed — ${err.message}`);
      continue;
    }
    if (amazonPrice == null) {
      console.warn(`${sku} (${asin}): no price returned by Amazon — skipping.`);
      continue;
    }

    const row = existingBySku.get(sku);
    const current = row?.price != null ? Number(row.price) : null;
    console.log(`${sku}: Amazon=$${amazonPrice}  current=$${current ?? "(none)"}`);

    if (current === amazonPrice && row?.stripe_price_id) continue;
    if (!row?.stripe_product_id) {
      console.warn(`${sku}: no stripe_product_id in Supabase — skipping change.`);
      continue;
    }
    changes.set(sku, amazonPrice);
  }

  if (changes.size === 0) {
    console.log("No price changes needed.");
    return;
  }

  if (!APPLY) {
    console.log("DRY RUN — would update:", Array.from(changes.entries()).map(([s, p]) => `${s}=$${p}`).join(", "));
    return;
  }

  for (const [sku, price] of changes) {
    const row = existingBySku.get(sku);
    const newPriceId = await updateStripePrice(row.stripe_product_id, sku, price);
    await upsert("inventory", [{ sku, price, stripe_price_id: newPriceId, updated_at: new Date().toISOString() }], "sku");
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME || "main";
  const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" };
  const fileRes = await fetch(`https://api.github.com/repos/${repo}/contents/products.html?ref=${branch}`, { headers });
  if (!fileRes.ok) throw new Error(`Fetch products.html failed (${fileRes.status})`);
  const { content, sha } = await fileRes.json();
  const currentHtml = Buffer.from(content, "base64").toString("utf-8");
  const updatedHtml = updateProductsHtml(currentHtml, changes);
  if (updatedHtml !== currentHtml) {
    await commitProductsHtml(updatedHtml, sha, branch, repo);
    console.log("Committed products.html price updates.");
  }
  console.log("Done:", Array.from(changes.keys()).join(", "));
}

main().catch((err) => { console.error(err); process.exit(1); });
