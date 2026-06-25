// scripts/supabase-client.js
//
// Minimal server-side Supabase client using the REST (PostgREST) interface
// directly — no SDK dependency, so no npm install step needed in CI.
//
// Uses the service_role key, which bypasses Row Level Security. That key
// must only ever live in GitHub Actions secrets (SUPABASE_SERVICE_ROLE_KEY)
// — never in client-side code, never in this repo's tracked files.

function assertEnv() {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

function headers() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

/**
 * Upsert one or more rows into a table, matched on `onConflict` (defaults
 * to the table's unique column convention used in schema.sql).
 */
async function upsert(table, rows, onConflict) {
  assertEnv();
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}`);
  if (onConflict) url.searchParams.set("on_conflict", onConflict);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...headers(),
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    throw new Error(`Supabase upsert into ${table} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * Simple select with PostgREST-style filters, e.g.
 * select("orders", { pii_purged: "eq.false" })
 */
async function select(table, filters = {}, columns = "*") {
  assertEnv();
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("select", columns);
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Supabase select from ${table} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function patch(table, filters, body) {
  assertEnv();
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...headers(), Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Supabase patch on ${table} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export { upsert, select, patch };
