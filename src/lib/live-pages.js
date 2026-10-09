// src/lib/live-pages.js
//
// Serves index.html / products.html with the CURRENT Supabase price and stock
// baked into the HTML itself (visible price text + JSON-LD schema), so
// crawlers (Google, LLMs) and no-JS visitors see the same numbers as the
// Stripe checkout and the Merchant feed. Supabase `inventory` is the single
// source of truth; the admin price panel writes to it.
//
// If Supabase is unreachable the static page is served unchanged.

import { sbSelect } from "./sb.js";

const IN_STOCK = "https://schema.org/InStock";
const OUT_OF_STOCK = "https://schema.org/OutOfStock";

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function patchJsonLd(node, bySku) {
  if (Array.isArray(node)) return node.forEach((n) => patchJsonLd(n, bySku));
  if (!node || typeof node !== "object") return;
  const row = node.sku ? bySku.get(node.sku) : null;
  if (row && node.offers && typeof node.offers === "object") {
    if (Number(row.price) > 0) node.offers.price = Number(row.price).toFixed(2);
    if (row.available_quantity != null) {
      node.offers.availability = Number(row.available_quantity) > 0 ? IN_STOCK : OUT_OF_STOCK;
    }
  }
  Object.values(node).forEach((v) => patchJsonLd(v, bySku));
}

export async function serveLivePage(request, env) {
  const res = await env.ASSETS.fetch(request);
  const type = res.headers.get("content-type") || "";
  if (res.status !== 200 || !type.includes("text/html")) return res;

  let rows;
  try {
    rows = await sbSelect(env, "inventory", {}, "sku,price,available_quantity");
  } catch (err) {
    console.error("live-pages: price fetch failed", err);
    return res;
  }
  const bySku = new Map((rows || []).map((r) => [r.sku, r]));

  let ldBuffer = "";
  const rewritten = new HTMLRewriter()
    .on("[data-price-sku]", {
      element(el) {
        const row = bySku.get(el.getAttribute("data-price-sku"));
        if (!row || !(Number(row.price) > 0)) return;
        el.setInnerContent((el.getAttribute("data-price-prefix") || "") + money(row.price));
      },
    })
    .on('script[type="application/ld+json"]', {
      text(chunk) {
        ldBuffer += chunk.text;
        if (!chunk.lastInTextNode) return chunk.remove();
        try {
          const json = JSON.parse(ldBuffer);
          patchJsonLd(json, bySku);
          chunk.replace(JSON.stringify(json, null, 2), { html: true });
        } catch {
          chunk.replace(ldBuffer, { html: true });
        }
        ldBuffer = "";
      },
    })
    .transform(res);

  const out = new Response(rewritten.body, rewritten);
  out.headers.delete("etag");
  out.headers.set("Cache-Control", "public, max-age=60");
  return out;
}
