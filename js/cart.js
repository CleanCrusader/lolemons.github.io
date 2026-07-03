// js/cart.js — client-side cart with slide-out drawer + multi-item checkout.
(function () {
  const KEY = "lol_cart";
  const CATALOG = {
    "FV-LNLR-DPRX": { name: "Clean Crusader — 24oz", price: 9.99, img: "images/Clean_Crusader_24oz.png" },
    "IT-3U6C-E8HZ": { name: "Concentrate — 16oz", price: 23.99, img: "images/Clean_Crusader_Concentrate.png" },
    "LOL1A": { name: "Pet Odor & Stain Eliminator", price: 19.99, img: "images/lol1a.jpg" },
  };

  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const write = (c) => localStorage.setItem(KEY, JSON.stringify(c));
  const count = (c) => Object.values(c).reduce((n, q) => n + q, 0);

  function add(sku, qty) {
    const c = read();
    c[sku] = Math.min((c[sku] || 0) + qty, 10);
    write(c); render(); open();
  }
  function setQty(sku, qty) {
    const c = read();
    if (qty <= 0) delete c[sku]; else c[sku] = Math.min(qty, 10);
    write(c); render();
  }

  function open() { document.getElementById("cartDrawer")?.classList.add("open"); document.getElementById("cartOverlay")?.classList.add("open"); }
  function close() { document.getElementById("cartDrawer")?.classList.remove("open"); document.getElementById("cartOverlay")?.classList.remove("open"); }

  function render() {
    const c = read();
    const n = count(c);
    document.querySelectorAll("[data-cart-count]").forEach((el) => {
      el.textContent = n; el.style.display = n > 0 ? "flex" : "none";
    });
    const body = document.getElementById("cartItems");
    const footer = document.getElementById("cartFooter");
    if (!body) return;
    const skus = Object.keys(c);
    if (skus.length === 0) {
      body.innerHTML = '<p class="cart-empty">Your cart is empty.</p>';
      if (footer) footer.style.display = "none";
      return;
    }
    let total = 0;
    body.innerHTML = skus.map((sku) => {
      const p = CATALOG[sku]; if (!p) return "";
      const line = p.price * c[sku]; total += line;
      return `<div class="cart-item">
        <img src="${p.img}" alt="${p.name}">
        <div class="cart-item-info">
          <div class="cart-item-name">${p.name}</div>
          <div class="cart-item-price">$${p.price.toFixed(2)}</div>
          <div class="cart-qty">
            <button data-dec="${sku}" aria-label="Decrease">−</button>
            <span>${c[sku]}</span>
            <button data-inc="${sku}" aria-label="Increase">+</button>
            <button class="cart-remove" data-rm="${sku}">Remove</button>
          </div>
        </div>
        <div class="cart-item-line">$${line.toFixed(2)}</div>
      </div>`;
    }).join("");
    if (footer) {
      footer.style.display = "block";
      document.getElementById("cartTotal").textContent = "$" + total.toFixed(2);
    }
  }

  async function checkout() {
    const c = read();
    const items = Object.entries(c).map(([sku, quantity]) => ({ sku, quantity }));
    if (items.length === 0) return;
    const btn = document.getElementById("cartCheckout");
    btn.disabled = true; btn.textContent = "Redirecting…";
    try {
      const res = await fetch("/api/create-cart-checkout", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
      });
      if (res.status === 409) {
        const d = await res.json().catch(() => ({}));
        const p = CATALOG[d.sku];
        alert(`Sorry — ${p ? p.name : d.sku} just sold out or has insufficient stock.`);
        btn.disabled = false; btn.textContent = "Checkout"; return;
      }
      if (!res.ok) throw new Error("checkout failed");
      const { url } = await res.json();
      window.location.href = url;
    } catch (e) {
      console.error(e);
      alert("Something went wrong starting checkout. Please try again.");
      btn.disabled = false; btn.textContent = "Checkout";
    }
  }

  document.addEventListener("click", (e) => {
    const addBtn = e.target.closest("[data-add-cart]");
    if (addBtn) {
      const card = addBtn.closest("[data-buy-sku]");
      const sku = card?.dataset.buySku || addBtn.dataset.addCart;
      const qty = parseInt(card?.querySelector("[data-buy-qty]")?.value, 10) || 1;
      add(sku, qty); return;
    }
    if (e.target.closest("[data-cart-open]")) { e.preventDefault(); open(); return; }
    if (e.target.id === "cartClose" || e.target.id === "cartOverlay") { close(); return; }
    const inc = e.target.closest("[data-inc]"); if (inc) { const c = read(); setQty(inc.dataset.inc, (c[inc.dataset.inc] || 0) + 1); return; }
    const dec = e.target.closest("[data-dec]"); if (dec) { const c = read(); setQty(dec.dataset.dec, (c[dec.dataset.dec] || 0) - 1); return; }
    const rm = e.target.closest("[data-rm]"); if (rm) { setQty(rm.dataset.rm, 0); return; }
    if (e.target.id === "cartCheckout") checkout();
  });

  document.addEventListener("DOMContentLoaded", render);
})();
