// js/contact.js
//
// Posts the contact form to /api/contact (Cloudflare Worker -> Resend).
// No third-party form service needed.
(function () {
  const form = document.querySelector("[data-contact-form]");
  if (!form) return;

  const status = form.querySelector("[data-contact-status]");
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (status) { status.textContent = "Sending…"; status.style.color = ""; }
    submitBtn.disabled = true;

    const payload = {
      name: form.querySelector('[name="name"]').value.trim(),
      email: form.querySelector('[name="email"]').value.trim(),
      topic: form.querySelector('[name="topic"]')?.value.trim() || "",
      message: form.querySelector('[name="message"]').value.trim(),
      company: form.querySelector('[name="company"]')?.value || "", // honeypot
    };

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (status) {
          status.textContent = data.message || "Something went wrong. Please try again.";
          status.style.color = "var(--rust)";
        }
        return;
      }

      if (status) {
        status.textContent = data.message || "Thanks — your message has been sent.";
        status.style.color = "var(--leaf)";
      }
      form.reset();
    } catch (err) {
      console.error(err);
      if (status) {
        status.textContent = "Something went wrong. Please email contact@lolemons.com directly.";
        status.style.color = "var(--rust)";
      }
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
