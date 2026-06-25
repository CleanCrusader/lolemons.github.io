// scripts/sync-prices.js
//
// Daily price check: reads each SKU's current Amazon price as synced into
// Veeqo (via the *native* Amazon channel — the one created by "Continue
// with Amazon", not the custom_integration channel used for fulfillment
// routing). If it's changed since the last check:
//
//   1. Create a new Stripe Price (prices are immutable once created —
//      this is the normal way to change one) and set it as the product's
//      default price.
//   2. Update Supabase's `inventory` row (price + stripe_price_id).
//   3. Commit the new price into products.html — both the visible
//      price tag and the Product structured data — so the site reflects
//      Amazon's price without anyone touching the repo by hand.
//
// Required env: VEEQO_API_KEY, STRIPE_SECRET_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY (the last
// two are auto-provided inside a GitHub Actions workflow).
//
// IMPORTANT CAVEAT: I haven't been able to call api.veeqo.com directly to
// confirm the exact shape of remote_price for your account (no network
// access to it from where I work). The field name and channel-finding
// logic below follow Veeqo's published docs. Watch the first few runs'
// logs in the Actions tab to confirm it's reading the right number.

import Stripe from "stripe";
import { upsert, select } from "./supabase-client.js";

const VEEQO_BASE = "https://api.veeqo.com";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SKUS = ["FV-LNLR-DPRX", "IT-3U6C-E8HZ", "LOL1A"];

async function veeqoFetch(path) {
  const res = await fetch(`${VEEQO_BASE}${path}`, {
    headers: { "x-api-key": process.env.VEEQO_API_KEY, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Veeqo GET ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function findNativeAmazonChannelId() {
  const channels = await veeqoFetch("/channels");
  const native = (Array.isArray(channels) ? channels : []).find((c) => c.type_code === "amazon");
  if (!native) {
    throw new Error(
      "No native Amazon channel found in Veeqo (type_code 'amazon'). " +
        "Is the 'Continue with Amazon' connection still active?"
    );
  }
  return native.id;
}

async function fetchRemotePrices(channelId) {
  let page = 1;
  const perPage = 100;
  const bySku = new Map();

  while (page <= 20) {
    const batch = await veeqoFetch(`/channels/${channelId}/channel_sellables?page_size=${perPage}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const cs of batch) {
      const sku = cs.remote_sku || cs.attributes?.remote_sku;
      const price = cs.remote_price ?? cs.attributes?.remote_price;
      if (sku && SKUS.includes(sku) && price !== undefined) {
        bySku.set(sku, Number(price));
      }
    }
    page += 1;
  }
  return bySku;
}

async function updateStripePrice(stripeProductId, sku, newPrice) {
  const newStripePrice = await stripe.prices.create({
    product: stripeProductId,
    currency: "usd",
    unit_amount: Math.round(newPrice * 100),
  });

  await stripe.products.update(stripeProductId, { default_price: newStripePrice.id });

  console.log(`${sku}: created new Stripe price ${newStripePrice.id} ($${newPrice})`);
  return newStripePrice.id;
}

// --- Static site content update -------------------------------------------

const SKU_TO_SLUG = {
  "FV-LNLR-DPRX": "clean-crusader-24oz",
  "IT-3U6C-E8HZ": "clean-crusader-concentrate",
  LOL1A: "pet-odor-eliminator",
};

function updateProductsHtml(html, priceChanges) {
  let updated = html;

  // 1. Visible price tag: <span class="price-amount" data-price="SKU">$X.XX</span>
  for (const [sku, newPrice] of priceChanges) {
    const re = new RegExp(`(data-price="${sku}">)[^<]*(</span>)`);
    updated = updated.replace(re, `$1$${newPrice.toFixed(2)}$2`);
  }

  // 2. Product structured data (JSON-LD) — parse, update, re-serialize so
  // formatting stays valid regardless of exact original whitespace.
  const ldMatch = updated.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldMatch) {
    const data = JSON.parse(ldMatch[1]);
    for (const node of data["@graph"] || []) {
      const slug = node["@id"]?.split("#")[1];
      const sku = Object.entries(SKU_TO_SLUG).find(([, s]) => s === slug)?.[0];
      const newPrice = sku && priceChanges.get(sku);
      if (newPrice && node.offers) {
        node.offers.price = newPrice.toFixed(2);
      }
    }
    const newScript = `<script type="application/ld+json">${JSON.stringify(data, null, 2)}\n</script>`;
    updated = updated.replace(ldMatch[0], newScript);
  }

  return updated;
}

async function commitToGitHub(newProductsHtml, sha) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const branch = "main";

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  await fetch(`https://api.github.com/repos/${repo}/contents/products.html`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: "Auto-update product price(s) from Amazon (via Veeqo sync)",
      content: Buffer.from(newProductsHtml, "utf-8").toString("base64"),
      sha,
      branch,
    }),
  });
}

async function main() {
  const channelId = await findNativeAmazonChannelId();
  const remotePrices = await fetchRemotePrices(channelId);

  const existingRows = await select("inventory", {}, "sku,price,stripe_product_id");
  const existingBySku = new Map(existingRows.map((r) => [r.sku, r]));

  const changes = new Map();

  for (const sku of SKUS) {
    const newPrice = remotePrices.get(sku);
    const existing = existingBySku.get(sku);

    if (newPrice === undefined) {
      console.warn(`${sku}: no remote_price found on the native Amazon channel — skipping.`);
      continue;
    }
    if (!existing?.stripe_product_id) {
      console.warn(`${sku}: no stripe_product_id stored in Supabase yet — can't update Stripe. Skipping.`);
      continue;
    }
    if (existing.price !== null && Number(existing.price) === newPrice) {
      console.log(`${sku}: price unchanged ($${newPrice}).`);
      continue;
    }

    console.log(`${sku}: price changed ${existing.price ?? "(none)"} -> ${newPrice}`);
    const newStripePriceId = await updateStripePrice(existing.stripe_product_id, sku, newPrice);

    await upsert(
      "inventory",
      [{ sku, price: newPrice, stripe_price_id: newStripePriceId, updated_at: new Date().toISOString() }],
      "sku"
    );

    changes.set(sku, newPrice);
  }

  if (changes.size === 0) {
    console.log("No price changes today.");
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" };
  const fileRes = await fetch(`https://api.github.com/repos/${repo}/contents/products.html?ref=main`, { headers });
  const { content, sha } = await fileRes.json();
  const currentHtml = Buffer.from(content, "base64").toString("utf-8");

  const updatedHtml = updateProductsHtml(currentHtml, changes);
  await commitToGitHub(updatedHtml, sha);
  console.log(`Committed updated price(s) for: ${Array.from(changes.keys()).join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
