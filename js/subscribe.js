// js/subscribe.js
//
// Newsletter/marketing-list signup, written straight to Supabase from the
// browser. This is safe specifically because of how the `subscribers`
// table is configured (see supabase/schema.sql): the anon key below can
// only INSERT into that one table — it can't read, update, or delete
// anything, enforced by a Row Level Security policy on Supabase's side,
// not by keeping this key secret. It's meant to be public.
//
// This is a completely separate system from the Amazon order data in
// scripts/sync-orders.js — nothing here ever touches buyer PII from
// Amazon orders. See the contact page / README for why that split matters.

(function () {
const SUPABASE_URL = "https://fkdjfrvyytkiutmwkzap.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrZGpmcnZ5eXRraXV0bXdremFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzMjYxMjUsImV4cCI6MjA5NzkwMjEyNX0.FYdTWjSWLuYPbxqsJ_U35_WYidlITNe1rx_hgQ0H9YI";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("[data-subscribe-form]");
  if (!form) return;

  const status = form.querySelector("[data-subscribe-status]");
  const submitBtn = form.querySelector("button[type=submit]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = form.querySelector("input[name=email]").value.trim();
    const name = form.querySelector("input[name=name]")?.value.trim() || null;
    const consentBox = form.querySelector("input[name=consent]");

    if (!consentBox || !consentBox.checked) {
      status.textContent = "Please check the consent box to subscribe.";
      return;
    }

    submitBtn.disabled = true;
    status.textContent = "Submitting…";

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ email, name, source: "website", consented: true }),
      });

      if (!res.ok && res.status !== 409) {
        // 409 = duplicate email (unique constraint) — treat as success,
        // no need to tell the visitor "you're already on the list" in a
        // way that reveals whether an email is already subscribed.
        throw new Error(`Request failed (${res.status})`);
      }

      form.reset();
      status.textContent = "You're on the list — thanks!";
    } catch (err) {
      console.error(err);
      status.textContent = "Something went wrong. Please try again in a moment.";
    } finally {
      submitBtn.disabled = false;
    }
  });
});
})();
