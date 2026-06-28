// js/reviews.js
//
// Reads approved reviews straight from Supabase's public_reviews VIEW
// (safe with the anon key -- that view excludes the email column entirely
// and only ever shows approved rows, see supabase/schema.sql). Submitting
// a review goes through the Worker instead of straight to Supabase,
// because verifying a purchase requires checking dtc_orders, which the
// anon key has no access to by design.
(function () {
  const SUPABASE_URL = "https://fkdjfrvyytkiutmwkzap.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrZGpmcnZ5eXRraXV0bXdremFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzMjYxMjUsImV4cCI6MjA5NzkwMjEyNX0.FYdTWjSWLuYPbxqsJ_U35_WYidlITNe1rx_hgQ0H9YI";

  function starString(rating) {
    return "★".repeat(rating) + "☆".repeat(5 - rating);
  }

  async function fetchReviews(sku) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/public_reviews`);
    url.searchParams.set("select", "customer_name,rating,review_text,created_at");
    url.searchParams.set("sku", `eq.${sku}`);
    url.searchParams.set("order", "created_at.desc");

    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) throw new Error(`Fetching reviews failed (${res.status})`);
    return res.json();
  }

  function renderSummary(panel, reviews) {
    const summaryEl = panel.querySelector("[data-reviews-summary]");
    if (!summaryEl) return;

    if (reviews.length === 0) {
      summaryEl.textContent = "No reviews yet — be the first to review this product";
      return;
    }

    const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
    summaryEl.innerHTML =
      `<span class="stars">${starString(Math.round(avg))}</span> ` +
      `${avg.toFixed(1)} out of 5 &middot; ${reviews.length} verified review${reviews.length === 1 ? "" : "s"}`;
  }

  function renderList(panel, reviews) {
    const listEl = panel.querySelector("[data-reviews-list]");
    if (!listEl) return;

    if (reviews.length === 0) {
      listEl.innerHTML = '<p class="review-empty">No reviews yet for this product.</p>';
      return;
    }

    listEl.innerHTML = reviews
      .map((r) => {
        const date = new Date(r.created_at).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
        const safeName = escapeHtml(r.customer_name);
        const safeText = escapeHtml(r.review_text);
        return `
          <div class="review-item">
            <div class="review-item-head">
              <span class="stars">${starString(r.rating)}</span>
              <span class="verified-badge" tabindex="0" data-tooltip="Only customers who have purchased this product can submit a review.">Verified Purchase</span>
            </div>
            <p class="review-author">${safeName} <span class="review-date">— ${date}</span></p>
            <p class="review-text">${safeText}</p>
          </div>
        `;
      })
      .join("");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function setUpStarInput(panel) {
    const starInput = panel.querySelector("[data-star-input]");
    if (!starInput) return;

    const buttons = Array.from(starInput.querySelectorAll("button"));

    function paint(value) {
      buttons.forEach((btn, idx) => {
        btn.textContent = idx < value ? "★" : "☆";
        btn.classList.toggle("filled", idx < value);
      });
    }

    buttons.forEach((btn, idx) => {
      btn.addEventListener("click", () => {
        const selected = idx + 1;
        starInput.dataset.value = String(selected);
        paint(selected);
      });
    });
  }

  async function handleSubmit(panel, sku, event) {
    event.preventDefault();
    const form = event.target;
    const status = form.querySelector("[data-review-status]");
    const submitBtn = form.querySelector('button[type="submit"]');
    const starInput = form.querySelector("[data-star-input]");
    const rating = parseInt(starInput?.dataset.value || "0", 10);

    if (!rating) {
      if (status) status.textContent = "Please select a star rating.";
      return;
    }

    const payload = {
      sku,
      name: form.querySelector('[name="name"]').value.trim(),
      email: form.querySelector('[name="email"]').value.trim(),
      rating,
      review_text: form.querySelector('[name="review_text"]').value.trim(),
    };

    submitBtn.disabled = true;
    if (status) status.textContent = "Submitting…";

    try {
      const res = await fetch("/api/submit-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        if (status) status.textContent = data.message || "Something went wrong. Please try again.";
        return;
      }

      if (status) status.textContent = data.message;
      form.reset();
      starInput.dataset.value = "0";
      const buttons = Array.from(starInput.querySelectorAll("button"));
      buttons.forEach((btn) => (btn.textContent = "☆"));
    } catch (err) {
      console.error(err);
      if (status) status.textContent = "Something went wrong. Please try again.";
    } finally {
      submitBtn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const panels = Array.from(document.querySelectorAll("[data-reviews-panel]"));

    panels.forEach(async (panel) => {
      const sku = panel.dataset.reviewsPanel;
      setUpStarInput(panel);

      const form = panel.querySelector("[data-review-form]");
      if (form) form.addEventListener("submit", (e) => handleSubmit(panel, sku, e));

      try {
        const reviews = await fetchReviews(sku);
        renderSummary(panel, reviews);
        renderList(panel, reviews);
      } catch (err) {
        console.error(err);
        const summaryEl = panel.querySelector("[data-reviews-summary]");
        if (summaryEl) summaryEl.textContent = "Reviews unavailable right now.";
      }
    });
  });
})();
