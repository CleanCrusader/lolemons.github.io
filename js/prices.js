// js/prices.js
//
// Single source of truth for displayed prices. Reads the current price for
// each product (as saved by the admin price panel) and updates every price
// element on the page. Any element with data-price-sku="SKU" gets its text
// set to the live price; elements with data-price-prefix keep their prefix
// text (e.g. "Shop Now — ") and append the price.
//
// This makes the admin price panel the single source of truth: change a
// price there and every page reflects it on next load. The hardcoded prices
// in the HTML are fallbacks shown only if this fetch fails.

(function () {
  const SUPABASE_URL = "https://fkdjfrvyytkiutmwkzap.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrZGpmcnZ5eXRraXV0bXdremFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzMjYxMjUsImV4cCI6MjA5NzkwMjEyNX0.FYdTWjSWLuYPbxqsJ_U35_WYidlITNe1rx_hgQ0H9YI";

  async function loadPrices() {
    try {
      const url = new URL(`${SUPABASE_URL}/rest/v1/inventory`);
      url.searchParams.set("select", "sku,price");
      const res = await fetch(url, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      });
      if (!res.ok) return null;
      const rows = await res.json();
      const bySku = {};
      rows.forEach((r) => { if (r.price != null) bySku[r.sku] = Number(r.price); });
      return bySku;
    } catch {
      return null;
    }
  }

  function apply(prices) {
    if (!prices) return; // keep hardcoded fallbacks
    // Expose for other scripts (e.g. cart) that load after.
    window.LOL_PRICES = prices;

    document.querySelectorAll("[data-price-sku]").forEach((el) => {
      const sku = el.getAttribute("data-price-sku");
      const price = prices[sku];
      if (price == null) return;
      const p = `$${price.toFixed(2)}`;
      const prefix = el.getAttribute("data-price-prefix");
      el.textContent = prefix ? `${prefix}${p}` : p;
    });

    document.dispatchEvent(new CustomEvent("lol-prices-ready", { detail: prices }));
  }

  document.addEventListener("DOMContentLoaded", async () => {
    apply(await loadPrices());
  });
})();
