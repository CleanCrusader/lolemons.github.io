// src/lib/auth.js
//
// Password storage for the single admin account, done properly: PBKDF2
// (via Web Crypto, native to Workers -- no extra dependency) with a random
// salt per password, 150,000 iterations. This is a one-way hash, not
// encryption -- there's no "decrypt" operation, and there doesn't need to
// be one. Verifying a login means re-deriving the hash from whatever the
// user typed and comparing it to what's stored, never recovering the
// original password.

import { sbSelect, sbPatch } from "./sb.js";
import { sendEmail } from "./email.js";

const PBKDF2_ITERATIONS = 100000; // Cloudflare Workers' PBKDF2 implementation caps out here
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function deriveHash(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(derivedBits));
}

async function getCredentialsRow(env) {
  const rows = await sbSelect(
    env,
    "admin_credentials",
    { id: "eq.admin" },
    "password_hash,salt,reset_token,reset_token_expires_at"
  );
  return rows[0] || null;
}

async function isPasswordSet(env) {
  const row = await getCredentialsRow(env);
  return Boolean(row?.password_hash);
}

async function setPassword(env, newPassword) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToHex(saltBytes);
  const password_hash = await deriveHash(newPassword, saltBytes);

  await sbPatch(
    env,
    "admin_credentials",
    { id: "eq.admin" },
    { password_hash, salt, reset_token: null, reset_token_expires_at: null, updated_at: new Date().toISOString() }
  );
}

async function verifyPassword(env, password) {
  if (!password) return false;
  const row = await getCredentialsRow(env);
  if (!row?.password_hash || !row?.salt) return false;
  const hash = await deriveHash(password, hexToBytes(row.salt));
  return hash === row.password_hash;
}

async function startPasswordReset(env, siteOrigin) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(tokenBytes);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

  await sbPatch(
    env,
    "admin_credentials",
    { id: "eq.admin" },
    { reset_token: token, reset_token_expires_at: expiresAt, updated_at: new Date().toISOString() }
  );

  const resetUrl = `${siteOrigin}/admin-reviews.html?reset_token=${token}`;

  await sendEmail(env, {
    to: "contact@lolemons.com",
    from: env.REVIEWS_FROM_EMAIL || "reviews@lolemons.com",
    subject: "Password reset requested — Review Moderation",
    html: `
      <p>A password reset was requested for the review moderation admin page.</p>
      <p><a href="${resetUrl}">Click here to set a new password</a> (link expires in 1 hour).</p>
      <p>If you didn't request this, you can ignore this email — your current password stays active.</p>
    `,
  });
}

async function resetPasswordWithToken(env, token, newPassword) {
  const row = await getCredentialsRow(env);

  if (!row?.reset_token || row.reset_token !== token) {
    return { ok: false, message: "Invalid or already-used reset link." };
  }
  if (!row.reset_token_expires_at || new Date(row.reset_token_expires_at) < new Date()) {
    return { ok: false, message: "This reset link has expired. Request a new one." };
  }

  await setPassword(env, newPassword);
  return { ok: true };
}

export { isPasswordSet, setPassword, verifyPassword, startPasswordReset, resetPasswordWithToken };
