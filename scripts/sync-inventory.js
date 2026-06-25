// scripts/sync-inventory.js
//
// Keeps Supabase's `inventory` table in sync with stock Veeqo already
// shows for each SKU — which itself stays in sync with FBA, since Veeqo
// owns that connection to your Amazon account. This avoids needing your
// own Amazon developer app (LWA credentials) just to read stock counts.
//
// Run via .github/workflows/sync-inventory.yml.
//
// Required env: VEEQO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { upsert } from "./supabase-client.js";

const VEEQO_BASE = "https://api.veeqo.com";

// Keep this in sync with the SKU_TO_ASIN map in src/worker.js.
const SKUS = ["FV-LNLR-DPRX", "IT-3U6C-E8HZ", "LOL1A"];

async function veeqoFetch(path) {
  const res = await fetch(`${VEEQO_BASE}${path}`, {
    headers: {
      "x-api-key": process.env.VEEQO_API_KEY,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Veeqo GET ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function fetchAllProducts() {
  let page = 1;
  const perPage = 100;
  const products = [];

  while (page <= 20) {
    const batch = await veeqoFetch(`/products?page_size=${perPage}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    products.push(...batch);
    page += 1;
  }
  return products;
}

async function main() {
  const products = await fetchAllProducts();

  const bySku = new Map();
  for (const product of products) {
    for (const sellable of product.sellables || []) {
      if (SKUS.includes(sellable.sku_code)) {
        bySku.set(sellable.sku_code, {
          sku: sellable.sku_code,
          asin: null, // Veeqo's product response doesn't reliably include this
          available_quantity: product.total_available_stock_level ?? 0,
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  const rows = Array.from(bySku.values());
  const missing = SKUS.filter((sku) => !bySku.has(sku));

  if (missing.length > 0) {
    // A SKU can be "missing" for two different reasons: it was never added
    // to Veeqo's catalog (a real setup gap), or it went inactive/unlinked
    // on Amazon (e.g. temporarily out of stock) and Veeqo stopped
    // returning it. Either way, the safe default is to show it as
    // out-of-stock on the site rather than silently keeping the last
    // known quantity — that's what was actually happening before this
    // fix, and it's wrong: a product that's gone inactive on Amazon could
    // otherwise keep showing as purchasable indefinitely.
    console.warn(`Not found in Veeqo (or inactive): ${missing.join(", ")} — marking as out-of-stock.`);
    for (const sku of missing) {
      rows.push({ sku, asin: null, available_quantity: 0, updated_at: new Date().toISOString() });
    }
  }

  console.log(`Found ${bySku.size} of ${SKUS.length} expected SKU(s) active in Veeqo's catalog.`);

  if (rows.length === 0) {
    console.log("Nothing to sync.");
    return;
  }

  await upsert("inventory", rows, "sku");
  console.log(`Synced ${rows.length} SKU(s) into Supabase inventory table.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
