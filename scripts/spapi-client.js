// scripts/spapi-client.js
//
// Minimal Selling Partner API client.
//
// As of Oct 2023, SP-API no longer requires AWS Signature v4 / IAM —
// every request just needs a valid LWA (Login with Amazon) bearer token
// in the `x-amz-access-token` header. See:
// https://developer-docs.amazon.com/sp-api/changelog/sp-api-will-no-longer-require-aws-iam-or-aws-signature-version-4
//
// Required environment variables (set as GitHub Actions secrets, never
// committed to the repo):
//   LWA_CLIENT_ID
//   LWA_CLIENT_SECRET
//   LWA_REFRESH_TOKEN
//
// Optional:
//   SPAPI_ENDPOINT          (default: NA region)
//   SPAPI_MARKETPLACE_ID    (default: US)

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

const REQUIRED_ENV = ["LWA_CLIENT_ID", "LWA_CLIENT_SECRET", "LWA_REFRESH_TOKEN"];

function assertEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Set these as repository secrets in GitHub (Settings > Secrets and variables > Actions)."
    );
  }
}

let cachedToken = null;
let cachedExpiry = 0;

async function getAccessToken() {
  assertEnv();
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 60_000) {
    return cachedToken;
  }

  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.LWA_REFRESH_TOKEN,
      client_id: process.env.LWA_CLIENT_ID,
      client_secret: process.env.LWA_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LWA token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedExpiry = now + data.expires_in * 1000;
  return cachedToken;
}

/**
 * Call an SP-API REST endpoint.
 * @param {string} path - e.g. "/orders/v0/orders"
 * @param {object} opts
 * @param {"GET"|"POST"|"PUT"|"PATCH"} [opts.method]
 * @param {object} [opts.query] - query string params
 * @param {object} [opts.body] - JSON request body
 */
async function spapiFetch(path, opts = {}) {
  const { method = "GET", query = {}, body } = opts;
  const endpoint = process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-na.amazon.com";
  const token = await getAccessToken();

  const url = new URL(endpoint + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    method,
    headers: {
      "x-amz-access-token": token,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await res.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }

  if (!res.ok) {
    throw new Error(`SP-API ${method} ${path} failed (${res.status}): ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

export const MARKETPLACE_IDS = {
  US: "ATVPDKIKX0DER",
  CA: "A2EUQ1WTGCTBG2",
  MX: "A1AM78C64UM0Y8",
  UK: "A1F83G8C2ARO7P",
};

export { spapiFetch, getAccessToken };
