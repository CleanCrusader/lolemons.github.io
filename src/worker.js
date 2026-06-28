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

const HOLD_MINUTES = 30; // Stripe requires expires_at to be at least 30 minutes out

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
  if (!env.SITE_URL) {
    return Response.json(
      { error: "config_error", message: "Missing Cloudflare env var: SITE_URL" },
      { status: 500 }
    );
  }
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
// POST /api/submit-review
// ---------------------------------------------------------------------------
const VERIFIED_ORDER_STATUSES = ["paid", "fulfilling", "shipped"];

async function handleSubmitReview(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body", message: "Invalid JSON body" }, { status: 400 });
  }

  const sku = String(body.sku || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  const rating = Math.max(1, Math.min(5, parseInt(body.rating, 10) || 0));
  const reviewText = String(body.review_text || "").trim();

  if (!sku || !email || !name || !rating || !reviewText) {
    return Response.json(
      { error: "missing_fields", message: "Name, email, a star rating, and review text are all required." },
      { status: 400 }
    );
  }

  // Purchase verification: this is the actual gate, not just a badge.
  // No completed order containing this SKU under this email = no review.
  const orders = await sbSelect(env, "dtc_orders", { customer_email: `ilike.${email}` }, "items,status");
  const verified = orders.some(
    (o) =>
      VERIFIED_ORDER_STATUSES.includes(o.status) &&
      Array.isArray(o.items) &&
      o.items.some((item) => item.sku === sku)
  );

  if (!verified) {
    return Response.json(
      {
        error: "not_verified",
        message: "We couldn't find a completed order for this product under that email address, so we can't publish a review.",
      },
      { status: 403 }
    );
  }

  // One review per email per SKU -- a verified buyer can't spam the form.
  const existing = await sbSelect(env, "reviews", { sku: `eq.${sku}`, customer_email: `ilike.${email}` }, "id");
  if (existing.length > 0) {
    return Response.json(
      { error: "duplicate_review", message: "Looks like you've already submitted a review for this product." },
      { status: 409 }
    );
  }

  await sbInsert(env, "reviews", {
    sku,
    customer_name: name,
    customer_email: email,
    rating,
    review_text: reviewText,
    status: "pending",
  });

  return Response.json({
    ok: true,
    message: "Thanks! Your purchase is verified -- your review will appear once it's been checked by our team.",
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/admin/setup-veeqo" && request.method === "GET") {
        return await handleSetupVeeqo(request, env);
      }

      if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
        return await handleCreateCheckoutSession(request, env);
      }

      if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
        return await handleStripeWebhook(request, env);
      }

      if (url.pathname === "/api/submit-review" && request.method === "POST") {
        return await handleSubmitReview(request, env);
      }
    } catch (err) {
      console.error(`Error handling ${url.pathname}:`, err);
      // Surfaced here deliberately while we're still in test mode, so
      // failures are debuggable without needing direct log access.
      // Worth tightening to a generic message before going fully live,
      // so internal error details aren't exposed to real customers.
      return Response.json({ error: "internal_error", message: String(err?.message || err) }, { status: 500 });
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
