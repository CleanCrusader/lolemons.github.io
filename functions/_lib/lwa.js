// functions/_lib/lwa.js
//
// Same LWA token exchange as scripts/spapi-client.js, but written for the
// Cloudflare Workers runtime — bindings come from the `env` object passed
// into each function, not process.env (Workers doesn't have that).
//
// Required env: LWA_CLIENT_ID, LWA_CLIENT_SECRET, LWA_REFRESH_TOKEN

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

export async function getLwaToken(env) {
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.LWA_REFRESH_TOKEN,
      client_id: env.LWA_CLIENT_ID,
      client_secret: env.LWA_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`LWA token exchange failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

export async function spapiFetch(env, path, opts = {}) {
  const { method = "GET", query = {}, body } = opts;
  const endpoint = env.SPAPI_ENDPOINT || "https://sellingpartnerapi-na.amazon.com";
  const token = await getLwaToken(env);

  const url = new URL(endpoint + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    method,
    headers: { "x-amz-access-token": token, "content-type": "application/json" },
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
