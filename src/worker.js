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
import {
  findProductBySku,
  ensureAmazonFulfillmentChannel,
  ensureChannelSellable,
  findFirstDeliveryMethodId,
  createOrderForFulfillment,
} from "./lib/veeqo.js";

const HOLD_MINUTES = 15;

// SKU -> Amazon ASIN, used only by the one-time /api/admin/setup-veeqo route
// to link each product to the Amazon fulfillment channel in Veeqo.
const SKU_TO_ASIN = {
  "FV-LNLR-DPRX": "B0DF5Y13MZ",
  "IT-3U6C-E8HZ": "B0C14RYXK2",
  LOL1A: "B08JQFG63X",
};

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
// One-time setup: GET /api/admin/setup-veeqo?key=ADMIN_SETUP_KEY
// Links each SKU to the Amazon fulfillment channel in Veeqo. Safe to run
// more than once — it skips anything already set up. Open the URL in a
// browser; no curl/Postman needed.
// ---------------------------------------------------------------------------
async function handleSetupVeeqo(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== env.ADMIN_SETUP_KEY) {
    return new Response("Forbidden", { status: 403 });
  }

  const log = [];
  const channelId = await ensureAmazonFulfillmentChannel(env);
  log.push(`Amazon fulfillment channel: ${channelId}`);

  for (const [sku, asin] of Object.entries(SKU_TO_ASIN)) {
    const product = await findProductBySku(env, sku);
    if (!product) {
      log.push(`SKU ${sku}: NOT FOUND in Veeqo's product catalog — add it there first, then re-run this.`);
      continue;
    }
    await ensureChannelSellable(env, channelId, product.sellableId, asin, sku, sku);
    log.push(`SKU ${sku}: linked (sellable ${product.sellableId}, ASIN ${asin})`);
  }

  const deliveryMethodId = await findFirstDeliveryMethodId(env);
  log.push(`Delivery method: ${deliveryMethodId ?? "NONE FOUND — add one in Veeqo first"}`);

  return new Response(log.join("\n"), { headers: { "content-type": "text/plain" } });
}

// ---------------------------------------------------------------------------
// Triggers fulfillment from FBA stock via Veeqo, once payment has succeeded.
// ---------------------------------------------------------------------------
async function createVeeqoFulfillmentOrder(env, dtcOrder) {
  const channelId = await ensureAmazonFulfillmentChannel(env);
  const deliveryMethodId = await findFirstDeliveryMethodId(env);

  const lineItems = [];
  for (const item of dtcOrder.items) {
    const product = await findProductBySku(env, item.sku);
    if (!product) {
      throw new Error(`SKU ${item.sku} not found in Veeqo — has it been added to the catalog there?`);
    }
    lineItems.push({ sellable_id: product.sellableId, quantity: item.quantity });
  }

  const [firstName, ...rest] = (dtcOrder.customer_name || dtcOrder.customer_email || "Customer").split(" ");

  return createOrderForFulfillment(env, {
    channelId,
    deliveryMethodId,
    customer: {
      email: dtcOrder.customer_email,
      billing_address_attributes: {
        first_name: firstName,
        last_name: rest.join(" ") || firstName,
        address1: dtcOrder.ship_address_line1,
        address2: dtcOrder.ship_address_line2 || "",
        city: dtcOrder.ship_city,
        state: dtcOrder.ship_state,
        zip: dtcOrder.ship_postal_code,
        country: dtcOrder.ship_country || "US",
      },
    },
    deliverTo: {
      first_name: firstName,
      last_name: rest.join(" ") || firstName,
      address1: dtcOrder.ship_address_line1,
      address2: dtcOrder.ship_address_line2 || "",
      city: dtcOrder.ship_city,
      state: dtcOrder.ship_state,
      zip: dtcOrder.ship_postal_code,
      country: dtcOrder.ship_country || "US",
    },
    lineItems,
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
    const fulfillment = await createVeeqoFulfillmentOrder(env, order);
    await sbPatch(
      env,
      "dtc_orders",
      { stripe_session_id: `eq.${session.id}` },
      {
        status: "fulfilling",
        amazon_fulfillment_order_id: fulfillment?.id ? String(fulfillment.id) : null,
        updated_at: new Date().toISOString(),
      }
    );
  } catch (err) {
    console.error("Veeqo fulfillment order failed:", err);
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

    if (url.pathname === "/api/admin/setup-veeqo" && request.method === "GET") {
      return handleSetupVeeqo(request, env);
    }

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
