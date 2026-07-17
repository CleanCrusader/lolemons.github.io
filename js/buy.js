// js/buy.js
//
// Drives the "Buy Now" flow on product cards. Reads live stock straight
// from Supabase (safe with the anon key — that table only allows public
// SELECT, see supabase/schema.sql), then POSTs to the Cloudflare Pages
// Function that creates a Stripe Checkout Session. The Cloudflare function
// re-checks and atomically reserves stock server-side — this client-side
// check is purely for a responsive "in stock / out of stock" display, not
// the actual oversell guard.

(function () {
const SUPABASE_URL = "https://fkdjfrvyytkiutmwkzap.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrZGpmcnZ5eXRraXV0bXdremFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzMjYxMjUsImV4cCI6MjA5NzkwMjEyNX0.FYdTWjSWLuYPbxqsJ_U35_WYidlITNe1rx_hgQ0H9YI";

async function fetchStock(skus) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/inventory`);
  url.searchParams.set("select", "sku,available_quantity,price");
  url.searchParams.set("sku", `in.(${skus.join(",")})`);

  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`Stock lookup failed (${res.status})`);

  const rows = await res.json();
  const bySku = {};
  for (const row of rows) bySku[row.sku] = { available: row.available_quantity, price: row.price };
  return bySku;
}

function renderPrice(sku, price) {
  if (price == null) return;
  const p = Number(price).toFixed(2);
  // Update the big visible price and any structured-data-adjacent spans.
  const card = document.querySelector(`[data-buy-sku="${sku}"]`);
  if (card) {
    const main = card.querySelector(".product-price");
    if (main) main.textContent = `$${p}`;
  }
}

function renderStock(card, available) {
  const badge = card.querySelector("[data-stock-badge]");
  const buyBtn = card.querySelector("[data-buy-button]");
  const qtyInput = card.querySelector("[data-buy-qty]");

  if (available === undefined) {
    if (badge) badge.textContent = "Stock status unavailable";
    return;
  }

  if (available > 0) {
    if (badge) {
      badge.textContent = available <= 5 ? `Only ${available} left` : "In stock";
      badge.classList.remove("out-of-stock");
    }
    if (buyBtn) buyBtn.disabled = false;
    if (qtyInput) qtyInput.max = String(Math.min(available, 10));
  } else {
    if (badge) {
      badge.textContent = "Out of stock";
      badge.classList.add("out-of-stock");
    }
    if (buyBtn) {
      buyBtn.disabled = true;
      buyBtn.textContent = "Out of Stock";
    }
  }
}

async function startCheckout(card) {
  const sku = card.dataset.buySku;
  const qtyInput = card.querySelector("[data-buy-qty]");
  const buyBtn = card.querySelector("[data-buy-button]");
  const status = card.querySelector("[data-buy-status]");
  const quantity = Math.max(1, Math.min(10, parseInt(qtyInput?.value, 10) || 1));

  buyBtn.disabled = true;
  const originalText = buyBtn.textContent;
  buyBtn.textContent = "Redirecting to checkout…";
  if (status) status.textContent = "";

  try {
    const res = await fetch("/api/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku, quantity }),
    });

    if (res.status === 409) {
      renderStock(card, 0);
      if (status) status.textContent = "Sorry — just sold out. Try a smaller quantity or check back soon.";
      buyBtn.textContent = originalText;
      return;
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`Checkout failed (${res.status}): ${errBody.message || errBody.error || "no detail"}`);
    }

    const { url } = await res.json();
    window.location.href = url;
  } catch (err) {
    console.error(err);
    if (status) status.textContent = "Something went wrong starting checkout. Please try again.";
    buyBtn.disabled = false;
    buyBtn.textContent = originalText;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const cards = Array.from(document.querySelectorAll("[data-buy-sku]"));
  if (cards.length === 0) return;

  const skus = cards.map((c) => c.dataset.buySku);

  try {
    const stock = await fetchStock(skus);
    cards.forEach((card) => {
      const sku = card.dataset.buySku;
      const entry = stock[sku];
      renderStock(card, entry ? entry.available : undefined);
      if (entry) renderPrice(sku, entry.price);
    });
  } catch (err) {
    console.error(err);
    cards.forEach((card) => renderStock(card, undefined));
  }

  cards.forEach((card) => {
    const buyBtn = card.querySelector("[data-buy-button]");
    if (buyBtn) buyBtn.addEventListener("click", () => startCheckout(card));
  });
});
})();
