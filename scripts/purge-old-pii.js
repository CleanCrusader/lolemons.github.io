// scripts/purge-old-pii.js
//
// Amazon's Data Protection Policy caps how long a seller's systems may
// retain buyer PII: no longer than necessary to fulfill the order, and
// not longer than 30 days after shipment/delivery in the general case.
// This job finds orders past their `pii_purge_after` timestamp and nulls
// the PII columns, keeping the non-PII record (status, totals, dates)
// for your own business records.
//
// Run daily via .github/workflows/purge-pii.yml.

import { select, patch } from "./supabase-client.js";

async function main() {
  const nowIso = new Date().toISOString();

  const dueForPurge = await select(
    "orders",
    {
      pii_purged: "eq.false",
      pii_purge_after: `lte.${nowIso}`,
    },
    "amazon_order_id"
  );

  if (dueForPurge.length === 0) {
    console.log("Nothing due for PII purge.");
    return;
  }

  console.log(`Purging PII for ${dueForPurge.length} order(s).`);

  for (const { amazon_order_id } of dueForPurge) {
    await patch(
      "orders",
      { amazon_order_id: `eq.${amazon_order_id}` },
      {
        buyer_name: null,
        ship_address_line1: null,
        ship_address_line2: null,
        ship_city: null,
        ship_state: null,
        ship_postal_code: null,
        ship_country: null,
        pii_purged: true,
        updated_at: new Date().toISOString(),
      }
    );
    console.log(`Purged PII for ${amazon_order_id}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
