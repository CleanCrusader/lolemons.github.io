// functions/api/create-checkout-session.js
//
// POST { sku: string, quantity: number }
//
// 1. Look up the SKU's Stripe Price ID + confirm there's enough unheld
//    stock, atomically reserving it via the try_reserve_inventory RPC
//    (see supabase/schema.sql) — this is the actual oversell guard, not
//    just a UI nicety.
// 2. Create a Stripe Checkout Session for that one item, with a short
//    expiry so abandoned carts free up stock again quickly.
//
// Required env (set in Cloudflare Pages > Settings > Environment variables,
// as *secrets*, not plaintext): STRIPE_SECRET_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SITE_URL (e.g. https://lolemons.com)

import Stripe from "stripe";
import { sbSelect, sbRpc } from "../_lib/sb.js";

const HOLD_MINUTES = 15;

function getStripe(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export async function onRequestPost({ request, env }) {
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

  // Reserve stock against the *real* session id — no temp-id swap, so
  // there's no window where the reservation doesn't exist.
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
