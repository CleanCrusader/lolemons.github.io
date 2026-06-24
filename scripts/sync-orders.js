// scripts/sync-orders.js
//
// Polls the SP-API Orders endpoint for unshipped, merchant-fulfilled (FBM)
// orders and opens a GitHub Issue for each new one, so you get notified and
// have a single place to track "needs fulfillment" work — no database
// required.
//
// Run via the "Sync Amazon Orders" GitHub Actions workflow
// (.github/workflows/sync-orders.yml), which runs on a schedule and passes
// in GITHUB_TOKEN / GITHUB_REPOSITORY automatically.

import { spapiFetch, MARKETPLACE_IDS } from "./spapi-client.js";

const MARKETPLACE_ID = process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_IDS.US;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // "owner/repo", auto-set in Actions
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // auto-provided in Actions
const LOOKBACK_HOURS = Number(process.env.ORDER_LOOKBACK_HOURS || 48);

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

async function findExistingIssueTitles() {
  // Pull open + recently closed issues labeled "amazon-order" so we don't
  // create duplicates on every run.
  const issues = await ghFetch("/issues?state=all&labels=amazon-order&per_page=100");
  return new Set(issues.map((issue) => issue.title));
}

function issueTitleFor(order) {
  return `Amazon order ${order.AmazonOrderId} — needs fulfillment`;
}

function issueBodyFor(order) {
  const total = order.OrderTotal ? `${order.OrderTotal.Amount} ${order.OrderTotal.CurrencyCode}` : "n/a";
  return [
    `**Order ID:** \`${order.AmazonOrderId}\``,
    `**Status:** ${order.OrderStatus}`,
    `**Purchase date:** ${order.PurchaseDate}`,
    `**Ship by:** ${order.LatestShipDate || "n/a"}`,
    `**Fulfillment channel:** ${order.FulfillmentChannel}`,
    `**Order total:** ${total}`,
    "",
    "**To mark this shipped:** run the \"Confirm Amazon Shipment\" workflow " +
      "(Actions tab) with this order ID, the carrier, and the tracking number.",
    "",
    "_Filed automatically by sync-orders.js — buyer name/address are not pulled here " +
      "(Amazon requires a Restricted Data Token for PII). Get those from Seller Central " +
      "or extend this script with the Tokens API if you need it inline here._",
  ].join("\n");
}

async function main() {
  assertGithubEnv();

  const createdAfter = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const data = await spapiFetch("/orders/v0/orders", {
    query: {
      MarketplaceIds: MARKETPLACE_ID,
      OrderStatuses: "Unshipped,PartiallyShipped",
      CreatedAfter: createdAfter,
    },
  });

  const orders = (data && data.payload && data.payload.Orders) || [];
  console.log(`Fetched ${orders.length} order(s) from the last ${LOOKBACK_HOURS}h.`);

  const fbmOrders = orders.filter((o) => o.FulfillmentChannel === "MFN");
  console.log(`${fbmOrders.length} of those are merchant-fulfilled (FBM).`);

  if (fbmOrders.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const existingTitles = await findExistingIssueTitles();

  for (const order of fbmOrders) {
    const title = issueTitleFor(order);
    if (existingTitles.has(title)) {
      console.log(`Skipping ${order.AmazonOrderId} — issue already exists.`);
      continue;
    }

    await ghFetch("/issues", {
      method: "POST",
      body: JSON.stringify({
        title,
        body: issueBodyFor(order),
        labels: ["amazon-order", "needs-fulfillment"],
      }),
    });
    console.log(`Created issue for ${order.AmazonOrderId}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
