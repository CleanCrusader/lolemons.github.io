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
import { sendEmail } from "./lib/email.js";
import { isPasswordSet, setPassword, verifyPassword, startPasswordReset, resetPasswordWithToken } from "./lib/auth.js";
import {
  findProductBySku,
  ensureAmazonFulfillmentChannel,
  ensureChannelSellable,
  listDeliveryMethods,
  resolveDeliveryMethodId,
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
    shipping_options: [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: 0, currency: "usd" },
          display_name: "Standard Shipping",
          delivery_estimate: {
            minimum: { unit: "business_day", value: 3 },
            maximum: { unit: "business_day", value: 5 },
          },
        },
      },
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: 500, currency: "usd" },
          display_name: "Expedited Shipping",
          delivery_estimate: {
            minimum: { unit: "business_day", value: 1 },
            maximum: { unit: "business_day", value: 2 },
          },
        },
      },
    ],
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

// POST /api/create-cart-checkout — body: { items: [{ sku, quantity }, ...] }
async function handleCreateCartCheckout(request, env) {
  if (!env.SITE_URL) return Response.json({ error: "config_error", message: "Missing SITE_URL" }, { status: 500 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const items = (Array.isArray(body.items) ? body.items : [])
    .map((i) => ({ sku: String(i.sku || "").trim(), quantity: Math.max(1, Math.min(10, parseInt(i.quantity, 10) || 1)) }))
    .filter((i) => i.sku);
  if (items.length === 0) return Response.json({ error: "empty_cart" }, { status: 400 });

  const lineItems = [];
  for (const it of items) {
    const rows = await sbSelect(env, "inventory", { sku: `eq.${it.sku}` });
    const inv = rows[0];
    if (!inv || !inv.stripe_price_id) return Response.json({ error: "unknown_product", message: `Unknown: ${it.sku}` }, { status: 404 });
    lineItems.push({ price: inv.stripe_price_id, quantity: it.quantity });
  }

  const stripe = getStripe(env);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: lineItems,
    shipping_address_collection: { allowed_countries: ["US"] },
    shipping_options: [
      { shipping_rate_data: { type: "fixed_amount", fixed_amount: { amount: 0, currency: "usd" }, display_name: "Standard Shipping", delivery_estimate: { minimum: { unit: "business_day", value: 3 }, maximum: { unit: "business_day", value: 5 } } } },
      { shipping_rate_data: { type: "fixed_amount", fixed_amount: { amount: 500, currency: "usd" }, display_name: "Expedited Shipping", delivery_estimate: { minimum: { unit: "business_day", value: 1 }, maximum: { unit: "business_day", value: 2 } } } },
    ],
    expires_at: Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60,
    success_url: `${env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}/products.html`,
    metadata: { cart: JSON.stringify(items) },
  });

  const reserved = [];
  let failed = null;
  for (const it of items) {
    const ok = await sbRpc(env, "try_reserve_inventory", { p_sku: it.sku, p_qty: it.quantity, p_session_id: session.id, p_hold_minutes: HOLD_MINUTES });
    if (!ok) { failed = it.sku; break; }
    reserved.push(it.sku);
  }
  if (failed) {
    try { await stripe.checkout.sessions.expire(session.id); } catch (err) { console.error("expire failed:", err); }
    return Response.json({ error: "out_of_stock", sku: failed }, { status: 409 });
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
    try {
      const linkResult = await ensureChannelSellable(env, channelId, product.sellableId, asin, sku, sku);
      log.push(
        linkResult.alreadyLinked
          ? `SKU ${sku}: already linked (sellable ${product.sellableId}, ASIN ${asin})`
          : `SKU ${sku}: newly linked (sellable ${product.sellableId}, ASIN ${asin})`
      );
    } catch (err) {
      // Channel-sellable linking is for Buy Shipping Protection eligibility
      // only -- not required for orders to actually be created/fulfilled
      // (already confirmed working without it). Don't let a failure here
      // block the rest of this diagnostic, especially the delivery
      // methods list below, which is what actually matters right now.
      log.push(`SKU ${sku}: channel-sellable link failed (non-blocking, BSP-only): ${err.message}`);
    }
  }

  const methods = await listDeliveryMethods(env);
  if (methods.length === 0) {
    log.push("Delivery methods: NONE FOUND — add at least one in Veeqo (Settings > Delivery Methods) first.");
  } else {
    log.push(`Delivery methods found (${methods.length}) — confirm in Veeqo's channel settings which of these`);
    log.push(`map to Standard vs Expedited shipping in Amazon MCF, then set the two env vars below accordingly:`);
    for (const m of methods) {
      log.push(`  id=${m.id}  name="${m.name ?? "(unnamed)"}"  carrier=${m.carrier ?? "n/a"}`);
    }
  }
  log.push(
    env.VEEQO_DELIVERY_METHOD_ID_STANDARD
      ? `Currently pinned VEEQO_DELIVERY_METHOD_ID_STANDARD: ${env.VEEQO_DELIVERY_METHOD_ID_STANDARD}`
      : `VEEQO_DELIVERY_METHOD_ID_STANDARD is NOT set yet — Standard-shipping orders will fail at checkout until it is.`
  );
  log.push(
    env.VEEQO_DELIVERY_METHOD_ID_EXPEDITED
      ? `Currently pinned VEEQO_DELIVERY_METHOD_ID_EXPEDITED: ${env.VEEQO_DELIVERY_METHOD_ID_EXPEDITED}`
      : `VEEQO_DELIVERY_METHOD_ID_EXPEDITED is NOT set yet — Expedited-shipping orders will fail at checkout until it is.`
  );

  return new Response(log.join("\n"), { headers: { "content-type": "text/plain" } });
}

// ---------------------------------------------------------------------------
// Triggers fulfillment from FBA stock via Veeqo, once payment has succeeded.
// ---------------------------------------------------------------------------
async function createVeeqoFulfillmentOrder(env, dtcOrder) {
  const channelId = await ensureAmazonFulfillmentChannel(env);
  const deliveryMethodId = resolveDeliveryMethodId(env, dtcOrder.shipping_speed);

  const lineItems = [];
  for (const item of dtcOrder.items) {
    const product = await findProductBySku(env, item.sku);
    if (!product) {
      throw new Error(`SKU ${item.sku} not found in Veeqo — has it been added to the catalog there?`);
    }
    lineItems.push({ sellable_id: product.sellableId, quantity: item.quantity, price_per_unit: product.price ?? 0 });
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

  // Single "Buy Now" sends sku/quantity; cart sends a JSON array in cart.
  let orderItems;
  if (session.metadata?.cart) {
    try {
      orderItems = JSON.parse(session.metadata.cart).map((i) => ({ sku: i.sku, quantity: Number(i.quantity) || 1 }));
    } catch { orderItems = []; }
  } else {
    orderItems = [{ sku: session.metadata?.sku, quantity: parseInt(session.metadata?.quantity || "1", 10) }];
  }
  const shipping = fullSession.shipping_details || fullSession.customer_details;
  const shippingAmountCents = fullSession.shipping_cost?.amount_total ?? 0;
  const shippingSpeed = shippingAmountCents > 0 ? "expedited" : "standard";

  // Stripe retries webhooks when it doesn't get a fast 2xx response --
  // check whether this session is already recorded before inserting, so
  // retries don't crash on the unique constraint and instead just retry
  // the Veeqo call (which is what actually needs to succeed).
  let order;
  const existing = await sbSelect(
    env, "dtc_orders", { stripe_session_id: `eq.${session.id}` }, "*"
  );

  if (existing.length > 0) {
    order = existing[0];
    if (order.status !== "failed") {
      // Already fulfilling or fulfilled -- nothing to do, idempotent return.
      console.log(`Webhook replay for ${session.id}: already has status '${order.status}', skipping.`);
      return;
    }
    // status === "failed": the insert worked last time but Veeqo didn't.
    // Fall through and retry Veeqo with the existing row.
    console.log(`Webhook replay for ${session.id}: retrying Veeqo after previous failure.`);
  } else {
    // First time seeing this session.
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
      items: orderItems,
      amount_total: (fullSession.amount_total || 0) / 100,
      currency: fullSession.currency,
      shipping_speed: shippingSpeed,
      shipping_amount: shippingAmountCents / 100,
      status: "paid",
    });

    await sbRpc(env, "consume_inventory_hold", { p_session_id: session.id });
    order = Array.isArray(dtcOrderResult) ? dtcOrderResult[0] : dtcOrderResult;
  }

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
    console.error("Veeqo fulfillment order failed:", err?.message ?? err);
    await sbPatch(
      env,
      "dtc_orders",
      { stripe_session_id: `eq.${session.id}` },
      { status: "failed", fulfillment_error: String(err?.message ?? err).slice(0, 500), updated_at: new Date().toISOString() }
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
    if (event.type === "checkout.session.completed") {
      try {
        await sbPatch(env, "dtc_orders", { stripe_session_id: `eq.${event.data.object.id}` },
          { status: "failed", fulfillment_error: `[outer] ${String(err?.message ?? err)}`.slice(0, 500), updated_at: new Date().toISOString() });
      } catch {}
    }
  }

  return new Response("ok", { status: 200 });
}

// ---------------------------------------------------------------------------
// POST /api/submit-review
// ---------------------------------------------------------------------------
const VERIFIED_ORDER_STATUSES = ["paid", "fulfilling", "shipped"];

// 4-5 stars: auto-approved immediately. 3 and below: held for manual
// moderation, and triggers an internal alert + a customer auto-response
// so a low rating turns into an outreach opportunity instead of just
// sitting in a queue.
const AUTO_APPROVE_MIN_RATING = 4;
const NEGATIVE_REVIEW_MAX_RATING = 3;

async function notifyOnNegativeReview(env, { sku, name, email, rating, reviewText }) {
  const fromAddress = env.REVIEWS_FROM_EMAIL || "reviews@lolemons.com";

  try {
    await sendEmail(env, {
      to: "contact@lolemons.com",
      from: fromAddress,
      replyTo: email,
      subject: `New ${rating}-star review needs attention (${sku})`,
      html: `
        <p><strong>Product SKU:</strong> ${sku}</p>
        <p><strong>Rating:</strong> ${rating} / 5</p>
        <p><strong>Customer:</strong> ${name} (${email})</p>
        <p><strong>Review:</strong></p>
        <p>${reviewText}</p>
        <p>This review is held as "pending" in Supabase -- approve or reject it in the table editor.
        Reply-to on this email is set to the customer directly.</p>
      `,
    });
  } catch (err) {
    console.error("Failed to send internal review-alert email:", err);
  }

  try {
    await sendEmail(env, {
      to: email,
      from: fromAddress,
      replyTo: "contact@lolemons.com",
      subject: "We'd like to make this right",
      html: `
        <p>Hi ${name},</p>
        <p>Thanks for taking the time to share your experience with us. We're sorry to hear it didn't
        fully meet your expectations — that's not the experience we want anyone to have.</p>
        <p>We'd really like the chance to make this right. If you can reply to this email with a bit
        more detail about what happened, we'll do everything we can to help.</p>
        <p>— The Lots of Lemon team</p>
      `,
    });
  } catch (err) {
    console.error("Failed to send customer auto-response email:", err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/contact
// Contact form -> emails contact@lolemons.com via Resend, reply-to set to
// the sender so a normal "Reply" reaches them directly.
// ---------------------------------------------------------------------------
async function handleContact(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body", message: "Invalid request." }, { status: 400 });
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const topic = String(body.topic || "").trim();
  const message = String(body.message || "").trim();

  // Basic validation
  if (!name || !email || !message) {
    return Response.json(
      { error: "missing_fields", message: "Please fill in your name, email, and a message." },
      { status: 400 }
    );
  }
  // Loose email sanity check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "bad_email", message: "That email address doesn't look right." }, { status: 400 });
  }
  // Length guardrails (prevent abuse / oversized payloads)
  if (name.length > 120 || email.length > 200 || topic.length > 200 || message.length > 5000) {
    return Response.json({ error: "too_long", message: "One of your fields is too long." }, { status: 400 });
  }

  // Honeypot: if the hidden "company" field is filled, silently accept but
  // don't send (bots fill every field; humans never see this one).
  if (String(body.company || "").trim() !== "") {
    return Response.json({ ok: true, message: "Thanks — your message has been sent." });
  }

  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const fromAddress = env.REVIEWS_FROM_EMAIL || "reviews@lolemons.com";

  try {
    await sendEmail(env, {
      to: "contact@lolemons.com",
      from: fromAddress,
      replyTo: email,
      subject: topic ? `Contact form: ${esc(topic)}` : `Contact form message from ${esc(name)}`,
      html: `
        <p><strong>From:</strong> ${esc(name)} (${esc(email)})</p>
        ${topic ? `<p><strong>Topic:</strong> ${esc(topic)}</p>` : ""}
        <p><strong>Message:</strong></p>
        <p>${esc(message).replace(/\n/g, "<br>")}</p>
        <hr>
        <p style="color:#888;font-size:12px;">Reply directly to this email to respond to ${esc(name)}.</p>
      `,
    });
  } catch (err) {
    console.error("Contact form email failed:", err?.message ?? err);
    return Response.json(
      { error: "send_failed", message: "Something went wrong sending your message. Please email contact@lolemons.com directly." },
      { status: 500 }
    );
  }

  return Response.json({ ok: true, message: "Thanks — your message has been sent. We'll get back to you soon." });
}

async function handleSubmitReview(request, env, ctx) {
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

  const status = rating >= AUTO_APPROVE_MIN_RATING ? "approved" : "pending";

  await sbInsert(env, "reviews", {
    sku,
    customer_name: name,
    customer_email: email,
    rating,
    review_text: reviewText,
    status,
  });

  if (rating <= NEGATIVE_REVIEW_MAX_RATING) {
    // Fire-and-forget -- don't make the customer wait on email delivery
    // to get their submission confirmation.
    ctx.waitUntil(notifyOnNegativeReview(env, { sku, name, email, rating, reviewText }));
  }

  const message =
    status === "approved"
      ? "Thanks! Your purchase is verified and your review is now live."
      : "Thanks for the feedback -- your purchase is verified. We've let our team know so we can follow up and try to make this right.";

  return Response.json({ ok: true, message });
}

// ---------------------------------------------------------------------------
// GET  /api/admin/auth-status     -- is a password set up yet? (public --
//                                     reveals nothing but a boolean)
// POST /api/admin/setup-password  -- (re-)set the password using the
//                                     master ADMIN_SETUP_KEY. Works any
//                                     time, not just once -- doubles as a
//                                     permanent fallback if both the
//                                     password and the reset-via-email
//                                     flow are ever unavailable.
// POST /api/admin/change-password -- change password while logged in,
//                                     using the current password
// POST /api/admin/forgot-password -- emails a time-limited reset link to
//                                     contact@lolemons.com
// POST /api/admin/reset-password  -- complete a reset using that link's
//                                     token
// GET  /api/admin/pending-reviews -- list reviews awaiting moderation
// POST /api/admin/review-action   -- approve or reject by id
//
// pending-reviews/review-action are gated by the admin password itself
// (sent as a header, re-verified via PBKDF2 on every request -- there's
// no session to manage, which is plenty appropriate for a single-admin
// internal tool).
// ---------------------------------------------------------------------------
async function handleAuthStatus(request, env) {
  return Response.json({ password_set: await isPasswordSet(env) });
}

async function handleSetupPassword(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  if (body.setup_key !== env.ADMIN_SETUP_KEY) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!body.new_password || body.new_password.length < 8) {
    return Response.json({ error: "weak_password", message: "Password must be at least 8 characters." }, { status: 400 });
  }

  await setPassword(env, body.new_password);
  return Response.json({ ok: true });
}

async function handleChangePassword(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const validCurrent = await verifyPassword(env, body.current_password);
  if (!validCurrent) {
    return Response.json({ error: "wrong_password", message: "Current password is incorrect." }, { status: 403 });
  }
  if (!body.new_password || body.new_password.length < 8) {
    return Response.json({ error: "weak_password", message: "New password must be at least 8 characters." }, { status: 400 });
  }

  await setPassword(env, body.new_password);
  return Response.json({ ok: true });
}

async function handleForgotPassword(request, env) {
  const siteOrigin = new URL(request.url).origin; // works correctly whether
  // this is the production domain or a staging preview's hashed URL
  await startPasswordReset(env, siteOrigin);
  // Always return the same generic response regardless of internal state.
  return Response.json({ ok: true, message: "If an admin account exists, a reset link has been sent to contact@lolemons.com." });
}

async function handleResetPassword(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!body.new_password || body.new_password.length < 8) {
    return Response.json({ error: "weak_password", message: "Password must be at least 8 characters." }, { status: 400 });
  }

  const result = await resetPasswordWithToken(env, body.reset_token, body.new_password);
  if (!result.ok) {
    return Response.json({ error: "reset_failed", message: result.message }, { status: 400 });
  }
  return Response.json({ ok: true });
}

async function handleListPendingReviews(request, env) {
  if (!(await verifyPassword(env, request.headers.get("x-admin-password")))) {
    return new Response("Forbidden", { status: 403 });
  }

  const reviews = await sbSelect(
    env,
    "reviews",
    { status: "eq.pending", order: "created_at.desc" },
    "id,sku,customer_name,customer_email,rating,review_text,created_at"
  );
  return Response.json({ reviews });
}

async function handleUpdatePrice(request, env) {
  if (!(await verifyPassword(env, request.headers.get("x-admin-password")))) {
    return new Response("Forbidden", { status: 403 });
  }
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid_body" }, { status: 400 }); }

  const sku = String(body.sku || "").trim();
  const price = Number(body.price);
  if (!sku || !(price > 0)) {
    return Response.json({ error: "invalid_request", message: "sku and a positive price are required." }, { status: 400 });
  }

  const rows = await sbSelect(env, "inventory", { sku: `eq.${sku}` });
  const inv = rows[0];
  if (!inv) return Response.json({ error: "unknown_sku", message: `No inventory row for ${sku}.` }, { status: 404 });
  if (!inv.stripe_product_id) return Response.json({ error: "no_stripe_product", message: `No stripe_product_id for ${sku}.` }, { status: 400 });

  const stripe = getStripe(env);
  let newPrice;
  try {
    newPrice = await stripe.prices.create({
      product: inv.stripe_product_id,
      currency: "usd",
      unit_amount: Math.round(price * 100),
    });
    await stripe.products.update(inv.stripe_product_id, { default_price: newPrice.id });
  } catch (err) {
    return Response.json({ error: "stripe_failed", message: String(err?.message ?? err) }, { status: 502 });
  }

  await sbPatch(env, "inventory", { sku: `eq.${sku}` },
    { price, stripe_price_id: newPrice.id, updated_at: new Date().toISOString() });

  return Response.json({ ok: true, sku, price, stripe_price_id: newPrice.id });
}

async function handleReviewAction(request, env) {
  if (!(await verifyPassword(env, request.headers.get("x-admin-password")))) {
    return new Response("Forbidden", { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const { review_id, action } = body;
  if (!review_id || !["approve", "reject"].includes(action)) {
    return Response.json({ error: "invalid_request", message: "review_id and a valid action are required." }, { status: 400 });
  }

  await sbPatch(env, "reviews", { id: `eq.${review_id}` }, { status: action === "approve" ? "approved" : "rejected" });
  return Response.json({ ok: true });
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

      if (url.pathname === "/api/create-cart-checkout" && request.method === "POST") {
        return await handleCreateCartCheckout(request, env);
      }

      if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
        return await handleStripeWebhook(request, env);
      }

      if (url.pathname === "/api/submit-review" && request.method === "POST") {
        return await handleSubmitReview(request, env, ctx);
      }

      if (url.pathname === "/api/contact" && request.method === "POST") {
        return await handleContact(request, env, ctx);
      }

      if (url.pathname === "/api/admin/auth-status" && request.method === "GET") {
        return await handleAuthStatus(request, env);
      }

      if (url.pathname === "/api/admin/setup-password" && request.method === "POST") {
        return await handleSetupPassword(request, env);
      }

      if (url.pathname === "/api/admin/change-password" && request.method === "POST") {
        return await handleChangePassword(request, env);
      }

      if (url.pathname === "/api/admin/forgot-password" && request.method === "POST") {
        return await handleForgotPassword(request, env);
      }

      if (url.pathname === "/api/admin/reset-password" && request.method === "POST") {
        return await handleResetPassword(request, env);
      }

      if (url.pathname === "/api/admin/pending-reviews" && request.method === "GET") {
        return await handleListPendingReviews(request, env);
      }

      if (url.pathname === "/api/admin/review-action" && request.method === "POST") {
        return await handleReviewAction(request, env);
      }

      if (url.pathname === "/api/admin/update-price" && request.method === "POST") {
        return await handleUpdatePrice(request, env);
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
