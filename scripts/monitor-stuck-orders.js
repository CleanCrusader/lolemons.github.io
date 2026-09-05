// scripts/monitor-stuck-orders.js
//
// Runs on a schedule. Flags two situations that need manual attention:
//   1. status = 'failed'   -> something errored (missing shipping address,
//                             Veeqo rejected the order, etc.)
//   2. status = 'fulfilling' for longer than STUCK_HOURS -> order reached
//      Veeqo fine but never got pushed on to Amazon MCF (the "Ready to
//      Ship but never sent" pattern we saw with order #P-2094177611).
//
// Each flagged order is emailed once (dtc_orders.alerted_at is set after
// sending) so the same order doesn't re-alert every run.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
// ALERT_TO_EMAIL (defaults to david@lolemons.com), ALERT_FROM_EMAIL
// (defaults to alerts@lolemons.com).

import { patch } from "./supabase-client.js";

const STUCK_HOURS = Number(process.env.STUCK_HOURS || 24);
const ALERT_TO = process.env.ALERT_TO_EMAIL || "david@lolemons.com";
const ALERT_FROM = process.env.ALERT_FROM_EMAIL || "alerts@lolemons.com";

function assertEnv() {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

// One query, OR'd across both conditions, via PostgREST's or= syntax.
async function fetchFlaggedOrders() {
  const cutoff = new Date(Date.now() - STUCK_HOURS * 3600 * 1000).toISOString();
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/dtc_orders`);
  url.searchParams.set(
    "select",
    "id,stripe_session_id,customer_email,customer_name,items,status,amazon_fulfillment_order_id,fulfillment_error,shipping_speed,ship_address_line1,ship_city,ship_state,created_at,alerted_at"
  );
  url.searchParams.set("alerted_at", "is.null");
  url.searchParams.set(
    "or",
    `(status.eq.failed,and(status.eq.fulfilling,created_at.lt.${cutoff}))`
  );

  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase select failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function sendAlertEmail(orders) {
  const esc = (s) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const rows = orders
    .map((o) => {
      const ageHours = Math.round((Date.now() - new Date(o.created_at).getTime()) / 3600000);
      const reason =
        o.status === "failed"
          ? `FAILED — ${esc(o.fulfillment_error || "no error message recorded")}`
          : `STUCK — status "fulfilling" for ${ageHours}h without progressing (Veeqo order ${esc(o.amazon_fulfillment_order_id || "unknown")})`;
      const items = (o.items || []).map((i) => `${esc(i.sku)} x${i.quantity}`).join(", ");
      return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee;">${esc(o.customer_name)}<br><span style="color:#888;font-size:12px;">${esc(o.customer_email)}</span></td>
          <td style="padding:8px;border-bottom:1px solid #eee;">${items}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;">${esc(o.ship_city)}, ${esc(o.ship_state)}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;color:#b00;">${reason}</td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:sans-serif;max-width:640px;">
      <h2 style="color:#1a2e10;">Order${orders.length > 1 ? "s" : ""} needing attention</h2>
      <p>${orders.length} order${orders.length > 1 ? "s haven't" : " hasn't"} shipped and need${orders.length > 1 ? "" : "s"} a manual check in Veeqo/Amazon.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="text-align:left;background:#f7faf3;">
          <th style="padding:8px;">Customer</th><th style="padding:8px;">Items</th>
          <th style="padding:8px;">Ship to</th><th style="padding:8px;">Issue</th>
        </tr>
        ${rows}
      </table>
      <p style="color:#666;font-size:12px;margin-top:16px;">Automated check — Lots of Lemon order monitor.</p>
    </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: ALERT_FROM,
      to: ALERT_TO,
      subject: `⚠️ ${orders.length} order${orders.length > 1 ? "s" : ""} not yet shipped`,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend send failed (${res.status}): ${await res.text()}`);
}

async function main() {
  assertEnv();
  const orders = await fetchFlaggedOrders();

  if (orders.length === 0) {
    console.log("No stuck or failed orders found.");
    return;
  }

  console.log(`Found ${orders.length} order(s) needing attention:`);
  orders.forEach((o) => console.log(`  - ${o.customer_email} | ${o.status} | ${o.stripe_session_id}`));

  await sendAlertEmail(orders);

  const now = new Date().toISOString();
  for (const o of orders) {
    await patch("dtc_orders", { id: `eq.${o.id}` }, { alerted_at: now });
  }
  console.log(`Alert sent to ${ALERT_TO} and ${orders.length} order(s) marked alerted.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
