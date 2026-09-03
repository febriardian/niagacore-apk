import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const encoder = new TextEncoder();

function keyBytes(value: string): Uint8Array {
  const raw = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (raw.length !== 32) throw new Error("wallet_encryption_key_must_be_32_bytes");
  return raw;
}
function base64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function encrypt(accountNumber: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes(secret), "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(accountNumber)));
  return { algorithm: "AES-256-GCM", version: 1, iv: base64(iv), ciphertext: base64(encrypted) };
}
async function decrypt(payload: { iv: string; ciphertext: string }, secret: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes(secret), "AES-GCM", false, ["decrypt"]);
  const iv = Uint8Array.from(atob(payload.iv), (character) => character.charCodeAt(0));
  const encrypted = Uint8Array.from(atob(payload.ciphertext), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: cors });
  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secret = Deno.env.get("WALLET_ENCRYPTION_KEY_BASE64");
  if (!authorization || !url || !anonKey || !serviceKey || !secret) return Response.json({ error: "not_configured" }, { status: 503, headers: cors });
  const body = await request.json().catch(() => null);
  const userResponse = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: authorization } });
  const user = userResponse.ok ? await userResponse.json() : null;
  if (!user?.id) return Response.json({ error: "authentication_required" }, { status: 401, headers: cors });

  if (body?.action === "set") {
    const accountNumber = String(body.accountNumber ?? "").replace(/\s+/g, "");
    const bankCode = String(body.bankCode ?? "").trim().toUpperCase();
    if (!/^[0-9]{6,24}$/.test(accountNumber) || !/^[A-Z0-9_]{2,40}$/.test(bankCode) || String(body.accountHolder ?? "").trim().length < 3) {
      return Response.json({ error: "invalid_bank_account" }, { status: 400, headers: cors });
    }
    const tenantId = String(body.tenantId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return Response.json({ error: "tenant_required" }, { status: 400, headers: cors });
    const memberResponse = await fetch(`${url}/rest/v1/memberships?tenant_id=eq.${encodeURIComponent(tenantId)}&user_id=eq.${user.id}&active=eq.true&role=eq.owner&select=tenant_id&limit=1`, {
      headers: { apikey: anonKey, Authorization: authorization },
    });
    const members = memberResponse.ok ? await memberResponse.json() : [];
    if (!Array.isArray(members) || members.length !== 1) return Response.json({ error: "owner_required" }, { status: 403, headers: cors });
    let encrypted;
    try { encrypted = await encrypt(accountNumber, secret); }
    catch { return Response.json({ error: "invalid_encryption_configuration" }, { status: 503, headers: cors }); }
    const result = await fetch(`${url}/rest/v1/withdrawal_accounts`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ tenant_id: members[0].tenant_id, bank_code: bankCode, account_holder: String(body.accountHolder).trim(), account_last4: accountNumber.slice(-4), encrypted_account: encrypted, created_by: user.id }),
    });
    return new Response(await result.text(), { status: result.status, headers: cors });
  }

  if (body?.action === "reveal") {
    const permissionResponse = await fetch(`${url}/rest/v1/rpc/admin_has_permission`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ requested_permission: "payout.account.verify" }),
    });
    const allowed = permissionResponse.ok ? await permissionResponse.json() : false;
    if (allowed !== true) return Response.json({ error: "payout_account_permission_required" }, { status: 403, headers: cors });
    const accountResponse = await fetch(`${url}/rest/v1/withdrawal_accounts?id=eq.${encodeURIComponent(body.accountId)}&select=id,tenant_id,encrypted_account&limit=1`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    const accounts = accountResponse.ok ? await accountResponse.json() : [];
    if (!Array.isArray(accounts) || accounts.length !== 1) return Response.json({ error: "account_not_found" }, { status: 404, headers: cors });
    const accountNumber = await decrypt(accounts[0].encrypted_account, secret);
    await fetch(`${url}/rest/v1/audit_events`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_id: accounts[0].tenant_id, actor_id: user.id, action: "wallet.account.reveal", resource_type: "withdrawal_account", resource_id: accounts[0].id, result: "success" }),
    });
    return Response.json({ accountId: accounts[0].id, accountNumber }, { headers: cors });
  }
  return Response.json({ error: "unsupported_action" }, { status: 400, headers: cors });
});
