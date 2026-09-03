import "jsr:@supabase/functions-js/edge-runtime.d.ts";

async function sha512(value: string) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-512", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function recordEvent(input: {
  url: string;
  serviceKey: string;
  reference?: string;
  hash: string;
  signatureValid: boolean;
  providerStatus?: string;
  processingStatus: "accepted" | "rejected" | "failed";
  errorCode?: string;
  metadata?: Record<string, unknown>;
}) {
  await fetch(`${input.url}/rest/v1/rpc/record_gateway_webhook_event`, {
    method: "POST",
    headers: { apikey: input.serviceKey, Authorization: `Bearer ${input.serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      target_reference: input.reference ?? "",
      target_hash: input.hash,
      target_signature_valid: input.signatureValid,
      target_provider_status: input.providerStatus ?? "",
      target_processing_status: input.processingStatus,
      target_error_code: input.errorCode ?? "",
      target_metadata: input.metadata ?? {},
    }),
  }).catch(() => null);
}

Deno.serve(async (request) => {
  if (request.method !== "POST")
    return new Response("method_not_allowed", { status: 405 });
  const body = await request.json().catch(() => null);
  const serverKey = Deno.env.get("MIDTRANS_SERVER_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  if (!body || !serverKey || !serviceKey || !url)
    return new Response("not_configured", { status: 503 });
  const eventHash = await sha256(JSON.stringify(body));
  const expected = await sha512(
    `${body.order_id}${body.status_code}${body.gross_amount}${serverKey}`,
  );
  if (expected !== body.signature_key) {
    await recordEvent({ url, serviceKey, reference: body.order_id, hash: eventHash, signatureValid: false,
      providerStatus: body.transaction_status, processingStatus: "rejected", errorCode: "invalid_signature" });
    return new Response("invalid_signature", { status: 401 });
  }
  if (!/^\d+(\.0+)?$/.test(String(body.gross_amount))) {
    await recordEvent({ url, serviceKey, reference: body.order_id, hash: eventHash, signatureValid: true,
      providerStatus: body.transaction_status, processingStatus: "rejected", errorCode: "invalid_amount" });
    return new Response("invalid_amount", { status: 400 });
  }
  const result = await fetch(`${url}/rest/v1/rpc/finalize_midtrans_payment`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      order_id: body.order_id,
      provider_status: body.transaction_status,
      gross_amount: Math.round(Number(body.gross_amount)),
      provider_payload: body,
    }),
  });
  if (!result.ok) {
    const detail = await result.text();
    await recordEvent({ url, serviceKey, reference: body.order_id, hash: eventHash, signatureValid: true,
      providerStatus: body.transaction_status, processingStatus: "failed", errorCode: "finalization_failed",
      metadata: { statusCode: body.status_code, grossAmount: String(body.gross_amount) } });
    return new Response(detail, { status: 500 });
  }
  await recordEvent({ url, serviceKey, reference: body.order_id, hash: eventHash, signatureValid: true,
    providerStatus: body.transaction_status, processingStatus: "accepted",
    metadata: { statusCode: body.status_code, grossAmount: String(body.gross_amount) } });
  return new Response("ok", { status: 200 });
});
