// scripts/sync-inventory.js
//
// Polls Amazon's FBA Inventory API for fulfillable stock and upserts it
// into Supabase's `inventory` table — the same table the site's "Buy"
// button reads from (public, read-only) and the checkout function reserves
// against. This is plain stock-count data, not PII, so no Restricted Data
// Token or special role is needed beyond the Product Listing role.
//
// Run via .github/workflows/sync-inventory.yml.

import { spapiFetch, MARKETPLACE_IDS } from "./spapi-client.js";
import { upsert } from "./supabase-client.js";

const MARKETPLACE_ID = process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_IDS.US;

async function fetchAllSummaries() {
  let nextToken;
  const summaries = [];

  do {
    const data = await spapiFetch("/fba/inventory/v1/summaries", {
      query: {
        details: "true",
        granularityType: "Marketplace",
        granularityId: MARKETPLACE_ID,
        marketplaceIds: MARKETPLACE_ID,
        ...(nextToken ? { nextToken } : {}),
      },
    });
    const payload = data?.payload || {};
    summaries.push(...(payload.inventorySummaries || []));
    nextToken = data?.pagination?.nextToken;
  } while (nextToken);

  return summaries;
}

async function main() {
  const summaries = await fetchAllSummaries();
  console.log(`Fetched ${summaries.length} FBA inventory summary row(s).`);

  if (summaries.length === 0) {
    console.log("Nothing to sync.");
    return;
  }

  const rows = summaries.map((item) => ({
    sku: item.sellerSku,
    asin: item.asin,
    available_quantity: item.inventoryDetails?.fulfillableQuantity ?? 0,
    updated_at: new Date().toISOString(),
  }));

  // Upsert without on_conflict overwriting stripe_price_id — PostgREST's
  // merge-duplicates resolution only touches the columns we send, so an
  // existing stripe_price_id value for a SKU is left alone.
  await upsert("inventory", rows, "sku");
  console.log(`Synced ${rows.length} SKU(s) into Supabase inventory table.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
