import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: cors });
  const authorization = request.headers.get("Authorization");
  const serverKey = Deno.env.get("MIDTRANS_SERVER_KEY");
  const environment = Deno.env.get("MIDTRANS_ENVIRONMENT")?.trim().toLowerCase();
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!authorization || !url || !anonKey) return Response.json({ error: "authentication_required" }, { status: 401, headers: cors });
  if (!serverKey || !serviceKey || environment !== "production") return Response.json({ error: "payment_backend_not_configured" }, { status: 503, headers: cors });
  const body = await request.json().catch(() => null);
  if (!body?.orderId) return Response.json({ error: "invalid_order" }, { status: 400, headers: cors });

  const adminCheck = await fetch(`${url}/rest/v1/rpc/admin_has_permission`, {
    method: "POST", headers: { apikey: anonKey, Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ requested_permission: "payment.reconcile" }),
  });
  const isAdmin = adminCheck.ok && (await adminCheck.json()) === true;
  const userResponse = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: authorization } });
  const currentUser = userResponse.ok ? await userResponse.json() : null;
  if (!currentUser?.id) return Response.json({ error: "authentication_required" }, { status: 401, headers: cors });

  // Merchant users are constrained by RLS; platform admins use the service role only after permission verification.
  const paymentCheck = await fetch(`${url}/rest/v1/payments?provider=eq.midtrans&provider_reference=eq.${encodeURIComponent(body.orderId)}&select=id,sale_id,amount_minor&limit=1`, {
    headers: isAdmin ? { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } : { apikey: anonKey, Authorization: authorization },
  });
  const payments = paymentCheck.ok ? await paymentCheck.json() : [];
  if (!Array.isArray(payments) || payments.length !== 1) return Response.json({ error: "payment_not_found" }, { status: 404, headers: cors });

  const base = "https://api.midtrans.com";
  const result = await fetch(`${base}/v2/${encodeURIComponent(body.orderId)}/status`, {
    headers: { Authorization: `Basic ${btoa(`${serverKey}:`)}`, Accept: "application/json" },
  });
  const provider = await result.json().catch(() => ({ error: "invalid_midtrans_response" }));
  if (!result.ok) return Response.json({ error: "midtrans_status_failed", provider }, { status: result.status, headers: cors });

  const status = String(provider.transaction_status ?? "pending");
  const amount = Math.round(Number(provider.gross_amount));
  if (!Number.isSafeInteger(amount) || amount < 0) return Response.json({ error: "invalid_provider_amount" }, { status: 502, headers: cors });
  const finalized = await fetch(`${url}/rest/v1/rpc/finalize_midtrans_payment`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: body.orderId, provider_status: status, gross_amount: amount, provider_payload: provider }),
  });
  if (!finalized.ok) return new Response(await finalized.text(), { status: 500, headers: cors });
  const canonical = await finalized.json();
  if (isAdmin) {
    const expectedAmount = Number(payments[0]?.amount_minor ?? 0);
    const reconciliationStatus = amount === expectedAmount ? "matched" : "mismatch";
    const recorded = await fetch(`${url}/rest/v1/rpc/record_admin_payment_reconciliation`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: body.orderId, target_status: reconciliationStatus,
        target_note: body.note ?? `Status Midtrans: ${status}`, target_actor: currentUser.id }),
    });
    if (!recorded.ok) return new Response(await recorded.text(), { status: 500, headers: cors });
  }
  return Response.json({ orderId: body.orderId, providerStatus: status, status: canonical.status, saleId: canonical.saleId }, { headers: cors });
});
