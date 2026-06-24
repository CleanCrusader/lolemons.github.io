// functions/api/stripe-webhook.js
//
// Handles two Stripe events:
//   - checkout.session.completed → record the order, consume the inventory
//     hold, and ask Amazon to ship it from FBA stock (Multi-Channel
//     Fulfillment, via the Fulfillment Outbound API's createFulfillmentOrder).
//   - checkout.session.expired → release the inventory hold so that stock
//     becomes available again.
//
// Required env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, LWA_CLIENT_ID, LWA_CLIENT_SECRET,
// LWA_REFRESH_TOKEN, SPAPI_MARKETPLACE_ID (optional, defaults to US)
//
// Point this at https://yourdomain.com/api/stripe-webhook in the Stripe
// Dashboard (Developers > Webhooks), subscribed to checkout.session.completed
// and checkout.session.expired.

import Stripe from "stripe";
import { sbInsert, sbPatch, sbRpc } from "../_lib/sb.js";
import { spapiFetch } from "../_lib/lwa.js";

function getStripe(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

async function createAmazonFulfillmentOrder(env, dtcOrder) {
  const marketplaceId = env.SPAPI_MARKETPLACE_ID || "ATVPDKIKX0DER";
  const items = dtcOrder.items.map((item, idx) => ({
    sellerSku: item.sku,
    sellerFulfillmentOrderItemId: String(idx + 1),
    quantity: item.quantity,
  }));

  const body = {
    sellerFulfillmentOrderId: `WEB-${dtcOrder.stripe_session_id}`.slice(0, 40),
    displayableOrderId: `WEB-${dtcOrder.id}`,
    displayableOrderDate: new Date().toISOString(),
    displayableOrderComment: "Thank you for your order!",
    shippingSpeedCategory: "Standard",
    destinationAddress: {
      name: dtcOrder.customer_name || dtcOrder.customer_email,
      addressLine1: dtcOrder.ship_address_line1,
      addressLine2: dtcOrder.ship_address_line2 || undefined,
      city: dtcOrder.ship_city,
      stateOrRegion: dtcOrder.ship_state,
      postalCode: dtcOrder.ship_postal_code,
      countryCode: dtcOrder.ship_country || "US",
    },
    items,
  };

  // NOTE: field names for createFulfillmentOrder should be double-checked
  // against the live SP-API reference / sandbox before relying on this for
  // real orders — Amazon has reshaped nested fulfillment schemas before.
  // https://developer-docs.amazon.com/sp-api/reference/createfulfillmentorder
  return spapiFetch(env, "/fba/outbound/2020-07-01/fulfillmentOrders", {
    method: "POST",
    query: {},
    body: { marketplaceId, ...body },
  });
}

async function handleCompleted(env, stripe, session) {
  const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["line_items"],
  });

  const sku = session.metadata?.sku;
  const quantity = parseInt(session.metadata?.quantity || "1", 10);
  const shipping = fullSession.shipping_details || fullSession.customer_details;

  const dtcOrder = await sbInsert(env, "dtc_orders", {
    stripe_session_id: session.id,
    stripe_payment_intent: session.payment_intent,
    customer_email: fullSession.customer_details?.email,
    customer_name: shipping?.name,
    ship_address_line1: shipping?.address?.line1,
    ship_address_line2: shipping?.address?.line2,
    ship_city: shipping?.address?.city,
    ship_state: shipping?.address?.state,
    ship_postal_code: shipping?.address?.postal_code,
    ship_country: shipping?.address?.country,
    items: [{ sku, quantity }],
    amount_total: (fullSession.amount_total || 0) / 100,
    currency: fullSession.currency,
    status: "paid",
  });

  await sbRpc(env, "consume_inventory_hold", { p_session_id: session.id });

  const order = Array.isArray(dtcOrder) ? dtcOrder[0] : dtcOrder;

  try {
    const fulfillment = await createAmazonFulfillmentOrder(env, order);
    await sbPatch(
      env,
      "dtc_orders",
      { stripe_session_id: `eq.${session.id}` },
      { status: "fulfilling", amazon_fulfillment_order_id: fulfillment?.payload?.fulfillmentOrderId || null, updated_at: new Date().toISOString() }
    );
  } catch (err) {
    console.error("Amazon MCF fulfillment order failed:", err);
    // Money's been collected; fulfillment failed to auto-trigger. Flag it
    // for a human rather than silently losing the order.
    await sbPatch(
      env,
      "dtc_orders",
      { stripe_session_id: `eq.${session.id}` },
      { status: "failed", updated_at: new Date().toISOString() }
    );
  }
}

export async function onRequestPost({ request, env }) {
  const signature = request.headers.get("stripe-signature");
  const payload = await request.text();
  const stripe = getStripe(env);

  let event;
  try {
    // Async + Web Crypto verification, required in the Workers runtime
    // (the sync constructEvent relies on Node's crypto module).
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider()
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCompleted(env, stripe, event.data.object);
    } else if (event.type === "checkout.session.expired") {
      await sbRpc(env, "release_inventory_hold", { p_session_id: event.data.object.id });
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err);
    // Still 200 — Stripe will retry on non-2xx, and retrying a partially
    // failed order-creation flow risks duplicate orders. Failures land in
    // Cloudflare's function logs and the dtc_orders.status field instead.
  }

  return new Response("ok", { status: 200 });
}
