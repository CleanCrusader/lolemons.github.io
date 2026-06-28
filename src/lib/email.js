// src/lib/email.js
//
// Minimal Resend client. Resend is the current recommended email API for
// Cloudflare Workers (Cloudflare's own docs point here -- MailChannels'
// old free Workers integration was discontinued, and Cloudflare's native
// Email Service is still in public beta as of this writing).
//
// Required env: RESEND_API_KEY
// Optional env: REVIEWS_FROM_EMAIL (defaults to reviews@lolemons.com --
// must be an address on a domain verified in your Resend account, or
// sends will fail/be restricted to your own sandbox address)

const RESEND_API = "https://api.resend.com/emails";

async function sendEmail(env, { to, from, replyTo, subject, html }) {
  if (!env.RESEND_API_KEY) {
    throw new Error("Missing Cloudflare env var: RESEND_API_KEY");
  }

  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: replyTo,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend send failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export { sendEmail };
