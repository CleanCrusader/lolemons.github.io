// scripts/sync-orders.js
//
// Polls SP-API for FBM orders that changed recently (new orders, or status
// changes like shipped/canceled — regardless of *how* they got shipped,
// whether that's Veeqo, Seller Central directly, or confirm-shipment.js).
// Two things happen with what it finds:
//
//   1. Upsert a row per order into Supabase `orders` (operational
//      fulfillment record — see supabase/schema.sql).
//   2. Keep GitHub Issues in sync as a lightweight "needs fulfillment"
//      board: open one for newly unshipped orders, close it automatically
//      once Amazon shows the order as shipped or canceled.
//
// Run via .github/workflows/sync-orders.yml.

import { spapiFetch, MARKETPLACE_IDS } from "./spapi-client.js";
import { upsert } from "./supabase-client.js";

const MARKETPLACE_ID = process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_IDS.US;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const LOOKBACK_HOURS = Number(process.env.ORDER_LOOKBACK_HOURS || 72);
const PII_RETENTION_DAYS = 30; // per Amazon's Data Protection Policy

function assertGithubEnv() {
  if (!GITHUB_REPOSITORY || !GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_REPOSITORY and GITHUB_TOKEN must be set. This script is designed to run inside a GitHub Actions workflow."
    );
  }
}

async function ghFetch(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// Map amazonOrderId -> open issue number, for dedup + auto-close.
async function findOpenIssuesByOrder() {
  const issues = await ghFetch("/issues?state=open&labels=amazon-order&per_page=100");
  const map = new Map();
  for (const issue of issues) {
    const match = issue.title.match(/Amazon order ([\w-]+)/);
    if (match) map.set(match[1], issue.number);
  }
  return map;
}

function issueBodyFor(order) {
  const total = order.OrderTotal ? `${order.OrderTotal.Amount} ${order.OrderTotal.CurrencyCode}` : "n/a";
  return [
    `**Order ID:** \`${order.AmazonOrderId}\``,
    `**Status:** ${order.OrderStatus}`,
    `**Purchase date:** ${order.PurchaseDate}`,
    `**Ship by:** ${order.LatestShipDate || "n/a"}`,
    `**Order total:** ${total}`,
    "",
    "Ship it however you normally do (Veeqo, Seller Central, etc.) — this issue closes " +
      "itself automatically once Amazon shows the order as shipped.",
    "",
    "_To force-confirm shipment from here instead, run the \"Confirm Amazon Shipment\" workflow._",
  ].join("\n");
}

function toDbStatus(orderStatus) {
  return (orderStatus || "unknown").toLowerCase();
}

function buildOrderRow(order) {
  const isTerminal = order.OrderStatus === "Shipped" || order.OrderStatus === "Canceled";
  const nowIso = new Date().toISOString();
  return {
    amazon_order_id: order.AmazonOrderId,
    status: toDbStatus(order.OrderStatus),
    fulfillment_channel: order.FulfillmentChannel,
    order_total: order.OrderTotal ? Number(order.OrderTotal.Amount) : null,
    currency: order.OrderTotal ? order.OrderTotal.CurrencyCode : null,
    purchase_date: order.PurchaseDate || null,
    ship_by: order.LatestShipDate || null,
    // Amazon's Orders API doesn't hand back an exact ship timestamp here —
    // this is "first time we observed the Shipped status", not necessarily
    // the precise moment it shipped. Good enough to drive the PII purge timer.
    shipped_at: order.OrderStatus === "Shipped" ? nowIso : null,
    pii_purge_after: isTerminal
      ? new Date(Date.now() + PII_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : null,
    updated_at: nowIso,
  };
}

async function main() {
  assertGithubEnv();

  const lastUpdatedAfter = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const data = await spapiFetch("/orders/v0/orders", {
    query: {
      MarketplaceIds: MARKETPLACE_ID,
      OrderStatuses: "Unshipped,PartiallyShipped,Shipped,Canceled",
      LastUpdatedAfter: lastUpdatedAfter,
    },
  });

  const orders = (data && data.payload && data.payload.Orders) || [];
  const fbmOrders = orders.filter((o) => o.FulfillmentChannel === "MFN");
  console.log(`Fetched ${orders.length} order(s) updated in the last ${LOOKBACK_HOURS}h; ${fbmOrders.length} are FBM.`);

  if (fbmOrders.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // 1. Mirror current state into Supabase regardless of GitHub issue state.
  const rows = fbmOrders.map(buildOrderRow);
  await upsert("orders", rows, "amazon_order_id");
  console.log(`Upserted ${rows.length} row(s) into Supabase orders table.`);

  // 2. Keep the GitHub Issues board in sync.
  const openIssues = await findOpenIssuesByOrder();

  for (const order of fbmOrders) {
    const existingIssue = openIssues.get(order.AmazonOrderId);

    if ((order.OrderStatus === "Unshipped" || order.OrderStatus === "PartiallyShipped") && !existingIssue) {
      await ghFetch("/issues", {
        method: "POST",
        body: JSON.stringify({
          title: `Amazon order ${order.AmazonOrderId} — needs fulfillment`,
          body: issueBodyFor(order),
          labels: ["amazon-order", "needs-fulfillment"],
        }),
      });
      console.log(`Opened issue for ${order.AmazonOrderId}.`);
    }

    if ((order.OrderStatus === "Shipped" || order.OrderStatus === "Canceled") && existingIssue) {
      await ghFetch(`/issues/${existingIssue}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `Amazon now shows this order as **${order.OrderStatus}**. Closing.` }),
      });
      await ghFetch(`/issues/${existingIssue}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      console.log(`Closed issue for ${order.AmazonOrderId} (${order.OrderStatus}).`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
