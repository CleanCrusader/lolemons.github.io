// src/lib/veeqo.js
//
// Minimal Veeqo API client. Veeqo already owns the connection to your
// Amazon account (the "Continue with Amazon" you set up earlier), so this
// avoids needing your own Amazon developer app / LWA credentials at all —
// Veeqo routes fulfillment to Amazon's Multi-Channel Fulfillment (MCF) on
// your behalf.
//
// Required env: VEEQO_API_KEY (Settings > Users > your user > generate API
// key in the Veeqo app — if you don't see that option, message Veeqo
// support first to ask them to enable API access on your account).
//
// IMPORTANT: response shapes here are based on Veeqo's published docs and
// examples, not a live test against your account (I don't have a way to
// call api.veeqo.com directly from where I'm working). Worth a quick check
// against the real responses once this is deployed — see the comments
// below on exactly which fields to verify.

const VEEQO_BASE = "https://api.veeqo.com";

async function veeqoFetch(env, path, opts = {}) {
  const { method = "GET", body } = opts;

  const res = await fetch(`${VEEQO_BASE}${path}`, {
    method,
    headers: {
      "x-api-key": env.VEEQO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    throw new Error(`Veeqo ${method} ${path} failed (${res.status}): ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

/**
 * Finds the sellable_id and current available stock for a SKU by paging
 * through /products and matching sku_code. Not the cheapest possible
 * approach, but it only has to work across 3 SKUs, and avoids guessing at
 * an unconfirmed search query parameter.
 *
 * VERIFY: `total_available_stock_level` is shown at the *product* level in
 * Veeqo's own example responses. That's fine as long as each product here
 * has exactly one sellable (true for a simple, non-variant catalog like
 * this one) — if that ever stops being true, this needs to look at the
 * specific sellable's own stock instead.
 */
async function findProductBySku(env, sku) {
  let page = 1;
  const perPage = 100;

  while (page <= 20) {
    const products = await veeqoFetch(env, `/products?page_size=${perPage}&page=${page}`);
    if (!Array.isArray(products) || products.length === 0) break;

    for (const product of products) {
      for (const sellable of product.sellables || []) {
        if (sellable.sku_code === sku) {
          return {
            productId: product.id,
            sellableId: sellable.id,
            price: sellable.price ?? null,
            availableStock: product.total_available_stock_level ?? null,
          };
        }
      }
    }
    page += 1;
  }

  return null;
}

async function getAvailableStockBySku(env, sku) {
  const found = await findProductBySku(env, sku);
  return found ? found.availableStock : null;
}

/**
 * One-time setup: finds or creates the "custom integration" channel Veeqo
 * requires for orders that should route to Amazon MCF for fulfillment.
 * See: https://developers.veeqo.com/guides/buyer-protection
 */
async function ensureAmazonFulfillmentChannel(env) {
  // If a channel is pinned, always use it — never create a new one.
  // Prevents duplicate "Website (Custom Integration)" channels piling up
  // on every deploy/diagnostic run.
  if (env.VEEQO_CHANNEL_ID) return env.VEEQO_CHANNEL_ID;

  const channels = await veeqoFetch(env, "/channels?type_code=custom_integration");
  const existing = (Array.isArray(channels) ? channels : []).find(
    (c) => c.custom_integration_channel_specific_attributes?.integration_type === "amazon"
  );
  if (existing) return existing.id;

  const created = await veeqoFetch(env, "/channels", {
    method: "POST",
    body: {
      channel: {
        name: "Website (Custom Integration)",
        type_code: "custom_integration",
        currency_code: "USD",
        short_name: "WB",
        veeqo_dictates_stock_level: false,
        custom_integration_channel_specific_attributes: { integration_type: "amazon" },
      },
    },
  });
  return created.id;
}

async function ensureChannelSellable(env, channelId, sellableId, asin, sku, title) {
  const existing = await veeqoFetch(env, `/channels/${channelId}/channel_sellables`).catch(() => []);
  if (Array.isArray(existing) && existing.some((cs) => cs.sellable_id === sellableId)) {
    return { alreadyLinked: true };
  }

  // Was previously posting to the flat /channel_sellables path while GET
  // used the channel-scoped one -- inconsistent, and the likely cause of
  // the 404 seen in testing. Using the same nested path for both now.
  const result = await veeqoFetch(env, `/channels/${channelId}/channel_sellables`, {
    method: "POST",
    body: {
      data: {
        type: "channel_sellables",
        attributes: {
          sellable_id: sellableId,
          channel_id: channelId,
          remote_id: asin,
          remote_sku: sku,
          remote_title: title,
        },
      },
    },
  });
  return { alreadyLinked: false, result };
}

// Lists every delivery method in the account, unfiltered -- used by the
// setup-veeqo diagnostic so a human can see exactly what's configured and
// identify which id genuinely maps to Standard shipping in Amazon MCF.
// Never used to silently pick one -- see resolveDeliveryMethodId below.
async function listDeliveryMethods(env) {
  const methods = await veeqoFetch(env, "/delivery_methods");
  return Array.isArray(methods) ? methods : [];
}

// Requires an explicitly verified, pinned delivery method id per speed
// (VEEQO_DELIVERY_METHOD_ID_STANDARD / _EXPEDITED, set after checking
// listDeliveryMethods' output against Veeqo's own channel-level shipping-
// speed mapping settings). Deliberately throws rather than falling back
// to "just pick one" -- guessing here risks silently shipping at the
// wrong speed/cost on every order, with no visible error.
function resolveDeliveryMethodId(env, speed) {
  const envVarName = speed === "expedited" ? "VEEQO_DELIVERY_METHOD_ID_EXPEDITED" : "VEEQO_DELIVERY_METHOD_ID_STANDARD";
  if (!env[envVarName]) {
    throw new Error(
      `${envVarName} is not set. Run /api/admin/setup-veeqo to see available delivery methods, ` +
        "confirm which one maps to this speed in Veeqo's channel settings, then set it as a Cloudflare secret."
    );
  }
  return env[envVarName];
}

async function createOrderForFulfillment(env, { channelId, deliveryMethodId, customer, deliverTo, lineItems }) {
  return veeqoFetch(env, "/orders", {
    method: "POST",
    body: {
      order: {
        channel_id: channelId,
        delivery_method_id: deliveryMethodId,
        customer_attributes: customer,
        deliver_to_attributes: deliverTo,
        line_items_attributes: lineItems,
        payment_attributes: { payment_type: "none", reference_number: "stripe" },
      },
    },
  });
}

export {
  veeqoFetch,
  findProductBySku,
  getAvailableStockBySku,
  ensureAmazonFulfillmentChannel,
  ensureChannelSellable,
  listDeliveryMethods,
  resolveDeliveryMethodId,
  createOrderForFulfillment,
};
