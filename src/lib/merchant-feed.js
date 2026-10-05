// src/lib/merchant-feed.js
//
// Builds the Google Merchant Center product feed (RSS 2.0 + g: namespace).
// Merchant Center fetches GET /api/merchant-feed.xml on a schedule, so prices
// and stock always reflect the live Supabase `inventory` table — the admin
// price panel stays the single source of truth.
//
// Static product details (title, description, GTIN, image, link) live in
// PRODUCTS below. Price and availability come from Supabase; PRICE_FALLBACK
// is only used if a price is missing there.
//
// Shipping, tax and returns are configured once in Merchant Center settings,
// not in this feed.

import { sbSelect } from "./sb.js";

const SITE = "https://lolemons.com";
const BRAND = "Lots of Lemon";
// Google product category 4973 = Home & Garden > Household Supplies >
// Household Cleaning Supplies > Household Cleaning Products
const GOOGLE_CATEGORY = "4973";

export const PRODUCTS = [
  {
    sku: "FV-LNLR-DPRX",
    title: "Clean Crusader Cold-Pressed Lemon Oil Cleaner, 24oz",
    description:
      "Ready-to-use cleaner made with cold-pressed lemon oil and a plant-based (coconut-derived) emulsifier, pre-mixed with water — no shaking, no separating. Scented with real lemon oil, not a synthetic fragrance. Safe for sealed countertops, tile, and most hard floors. Ingredients: filtered water, cold-pressed lemon oil, plant-based emulsifier.",
    gtin: "00860005194339",
    image: `${SITE}/images/Clean_Crusader_24oz.png`,
    link: `${SITE}/products.html#clean-crusader-24oz`,
    productType: "Cleaning Supplies > Lemon Oil Cleaners",
    priceFallback: "14.99",
  },
  {
    sku: "IT-3U6C-E8HZ",
    title: "Clean Crusader Cold-Pressed Lemon Oil Cleaner Concentrate, 16oz",
    description:
      "Full-strength, undiluted cleaner concentrate made with cold-pressed lemon oil and a plant-based emulsifier — no added water, so you choose the strength. Dilute for everyday cleaning or use stronger on grease and grime. Doubles as an air-freshener base for diffusers. Ingredients: cold-pressed lemon oil, plant-based emulsifier.",
    gtin: "860005194322",
    image: `${SITE}/images/Clean_Crusader_Concentrate.png`,
    link: `${SITE}/products.html#clean-crusader-concentrate`,
    productType: "Cleaning Supplies > Lemon Oil Cleaners",
    priceFallback: "23.99",
  },
  {
    sku: "LOL1A",
    title: "Pet Odor & Stain Eliminator with Cold-Pressed Lemon Oil, 24oz",
    description:
      "Enzyme and odor-encapsulation formula built for pet messes — urine, vomit, and stains on carpet, hardwood, fabric, and turf. Breaks down stains and odor at the source and traps what's left, finished with real cold-pressed lemon oil. Ingredients: filtered water, advanced biological enzyme and odor-encapsulation blend, cold-pressed lemon oil, SugaMulse (plant-based surfactant).",
    gtin: "00860005194308",
    image: `${SITE}/images/lol1a.jpg`,
    link: `${SITE}/products.html#pet-odor-eliminator`,
    productType: "Cleaning Supplies > Pet Odor & Stain Removers",
    priceFallback: "19.99",
  },
];

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatPrice(raw, fallback) {
  const n = Number(raw);
  const value = Number.isFinite(n) && n > 0 ? n : Number(fallback);
  return `${value.toFixed(2)} USD`;
}

// Pure function: inventory rows in, XML string out. Exported for testing.
export function buildMerchantFeed(inventoryRows) {
  const bySku = new Map((inventoryRows || []).map((r) => [r.sku, r]));

  const items = PRODUCTS.map((p) => {
    const row = bySku.get(p.sku);
    const inStock = row && Number(row.available_quantity) > 0;
    return `    <item>
      <g:id>${esc(p.sku)}</g:id>
      <g:title>${esc(p.title)}</g:title>
      <g:description>${esc(p.description)}</g:description>
      <g:link>${esc(p.link)}</g:link>
      <g:image_link>${esc(p.image)}</g:image_link>
      <g:availability>${inStock ? "in_stock" : "out_of_stock"}</g:availability>
      <g:price>${formatPrice(row?.price, p.priceFallback)}</g:price>
      <g:brand>${esc(BRAND)}</g:brand>
      <g:gtin>${esc(p.gtin)}</g:gtin>
      <g:condition>new</g:condition>
      <g:google_product_category>${GOOGLE_CATEGORY}</g:google_product_category>
      <g:product_type>${esc(p.productType)}</g:product_type>
    </item>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Lots of Lemon</title>
    <link>${SITE}</link>
    <description>Cold-pressed lemon oil cleaners from Lots of Lemon</description>
${items}
  </channel>
</rss>
`;
}

// GET /api/merchant-feed.xml
export async function handleMerchantFeed(env) {
  const skus = PRODUCTS.map((p) => p.sku).join(",");
  const rows = await sbSelect(env, "inventory", { sku: `in.(${skus})` }, "sku,price,available_quantity");
  return new Response(buildMerchantFeed(rows), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      // Short cache: keeps Supabase load trivial while prices stay near-live.
      "Cache-Control": "public, max-age=900",
      // Keep the feed out of search results; Merchant Center still fetches it.
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
