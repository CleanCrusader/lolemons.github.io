// src/worker.js
//
// Cloudflare Workers (with static assets) doesn't auto-detect a /functions
// folder the way classic Pages did — it needs one entry script that
// explicitly routes requests. wrangler.jsonc scopes run_worker_first to
// "/api/*", so this script only ever runs for those two routes; everything
// else (index.html, products.html, css/, js/, images/) is served directly
// from the assets directory without invoking this Worker at all.
//
// Required env (Cloudflare Pages/Workers > Settings > Variables and Secrets):
// STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, LWA_CLIENT_ID, LWA_CLIENT_SECRET,
// LWA_REFRESH_TOKEN, SITE_URL, SPAPI_MARKETPLACE_ID (optional)

import Stripe from "stripe";
import { sbInsert, sbPatch, sbSelect, sbRpc } from "./lib/sb.js";
import { spapiFetch } from "./lib/lwa.js";

const HOLD_MINUTES = 15;

function getStripe(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}

// ---------------------------------------------------------------------------
// POST /api/create-checkout-session
// ---------------------------------------------------------------------------
async function handleCreateCheckoutSession(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sku = String(body.sku || "").trim();
  const quantity = Math.max(1, Math.min(10, parseInt(body.quantity, 10) || 1));

  if (!sku) {
    return Response.json({ error: "Missing sku" }, { status: 400 });
  }

  const rows = await sbSelect(env, "inventory", { sku: `eq.${sku}` });
  const item = rows[0];
  if (!item || !item.stripe_price_id) {
    return Response.json({ error: "Unknown product" }, { status: 404 });
  }

  const stripe = getStripe(env);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: item.stripe_price_id, quantity }],
    shipping_address_collection: { allowed_countries: ["US"] },
    expires_at: Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60,
    success_url: `${env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}/products.html`,
    metadata: { sku, quantity: String(quantity) },
  });

  const reserved = await sbRpc(env, "try_reserve_inventory", {
    p_sku: sku,
    p_qty: quantity,
    p_session_id: session.id,
    p_hold_minutes: HOLD_MINUTES,
  });

  if (!reserved) {
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (err) {
      console.error("Failed to expire unreserved session:", err);
    }
    return Response.json({ error: "out_of_stock" }, { status: 409 });
  }

  return Response.json({ url: session.url });
}

// ---------------------------------------------------------------------------
// POST /api/stripe-webhook
// ---------------------------------------------------------------------------
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

  // Double-check field names against the live SP-API reference / sandbox
  // before relying on this for real orders:
  // https://developer-docs.amazon.com/sp-api/reference/createfulfillmentorder
  return spapiFetch(env, "/fba/outbound/2020-07-01/fulfillmentOrders", {
    method: "POST",
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

  const dtcOrderResult = await sbInsert(env, "dtc_orders", {
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

  const order = Array.isArray(dtcOrderResult) ? dtcOrderResult[0] : dtcOrderResult;

  try {
    const fulfillment = await createAmazonFulfillmentOrder(env, order);
    await sbPatch(
      env,
      "dtc_orders",
      { stripe_session_id: `eq.${session.id}` },
      {
        status: "fulfilling",
        amazon_fulfillment_order_id: fulfillment?.payload?.fulfillmentOrderId || null,
        updated_at: new Date().toISOString(),
      }
    );
  } catch (err) {
    console.error("Amazon MCF fulfillment order failed:", err);
    await sbPatch(
      env,
      "dtc_orders",
      { stripe_session_id: `eq.${session.id}` },
      { status: "failed", updated_at: new Date().toISOString() }
    );
  }
}

async function handleStripeWebhook(request, env) {
  const signature = request.headers.get("stripe-signature");
  const payload = await request.text();
  const stripe = getStripe(env);

  let event;
  try {
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
    // Still 200 — Stripe retries on non-2xx, and retrying a partially
    // failed order-creation flow risks duplicate orders.
  }

  return new Response("ok", { status: 200 });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
      return handleCreateCheckoutSession(request, env);
    }

    if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    // run_worker_first is scoped to "/api/*" in wrangler.jsonc, so in
    // practice nothing else reaches this point — but fall back to the
    // static asset just in case.
    return env.ASSETS.fetch(request);
  },
};
