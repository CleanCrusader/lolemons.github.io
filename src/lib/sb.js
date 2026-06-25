// functions/_lib/sb.js
//
// Minimal Supabase REST + RPC client for the Workers runtime. Uses the
// service_role key, set as a Cloudflare Pages secret — never the anon key.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

function headers(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function sbInsert(env, table, row) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...headers(env), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase insert into ${table} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function sbPatch(env, table, filters, body) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...headers(env), Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase patch on ${table} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function sbSelect(env, table, filters = {}, columns = "*") {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("select", columns);
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) throw new Error(`Supabase select from ${table} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function sbRpc(env, fnName, args) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Supabase rpc ${fnName} failed (${res.status}): ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
