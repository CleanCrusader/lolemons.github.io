// scripts/confirm-shipment.js
//
// Confirms shipment for a single merchant-fulfilled (FBM) order, marking it
// shipped on Amazon and attaching a tracking number. Calls the Orders API
// confirmShipment operation:
// https://developer-docs.amazon.com/sp-api/reference/confirmshipment
//
// Run via the "Confirm Amazon Shipment" GitHub Actions workflow
// (.github/workflows/confirm-shipment.yml), triggered manually from the
// Actions tab with the order ID, carrier, and tracking number as inputs.
//
// NOTE: Amazon's nested `packageDetail` schema has changed shape across
// API versions. The fields below (packageReferenceNumber, carrierCode,
// trackingNumber, shipDate, items) match the documented confirmShipment
// use case, but test once against the SP-API sandbox before relying on
// this in production — see the sandbox guide:
// https://developer-docs.amazon.com/sp-api/docs/sandbox-environments

import { spapiFetch, MARKETPLACE_IDS } from "./spapi-client.js";
import { patch } from "./supabase-client.js";

const MARKETPLACE_ID = process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_IDS.US;
const PII_RETENTION_DAYS = 30;

function requireArg(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required input: ${name}`);
  }
  return value;
}

async function getOrderItems(orderId) {
  const data = await spapiFetch(`/orders/v0/orders/${orderId}/orderItems`);
  return (data && data.payload && data.payload.OrderItems) || [];
}

async function confirmShipment({ orderId, carrierCode, trackingNumber, shipDate }) {
  const items = await getOrderItems(orderId);
  if (items.length === 0) {
    throw new Error(`No order items found for ${orderId} — double check the order ID.`);
  }

  const body = {
    marketplaceId: MARKETPLACE_ID,
    packageDetail: {
      packageReferenceId: "1",
      carrierCode,
      trackingNumber,
      shipDate: shipDate || new Date().toISOString(),
      items: items.map((item) => ({
        orderItemId: item.OrderItemId,
        quantity: item.QuantityOrdered,
      })),
    },
  };

  await spapiFetch(`/orders/v0/orders/${orderId}/shipmentConfirmation`, {
    method: "POST",
    body,
  });

  console.log(`Confirmed shipment for ${orderId} (${carrierCode}, tracking ${trackingNumber}).`);

  const nowIso = new Date().toISOString();
  await patch(
    "orders",
    { amazon_order_id: `eq.${orderId}` },
    {
      status: "shipped",
      carrier_code: carrierCode,
      tracking_number: trackingNumber,
      shipped_at: shipDate || nowIso,
      pii_purge_after: new Date(Date.now() + PII_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: nowIso,
    }
  );
  console.log(`Updated Supabase record for ${orderId}.`);
}

async function main() {
  const orderId = requireArg("ORDER_ID");
  const carrierCode = requireArg("CARRIER_CODE");
  const trackingNumber = requireArg("TRACKING_NUMBER");
  const shipDate = process.env.SHIP_DATE || undefined;

  await confirmShipment({ orderId, carrierCode, trackingNumber, shipDate });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
