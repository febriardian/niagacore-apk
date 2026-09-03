import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createTraceContext,traceHeaders} from "../_shared/observability.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return `sha256:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

Deno.serve(async (request) => {
  const trace=createTraceContext(request),tracedHeaders={...cors,...traceHeaders(trace)};
  if (request.method === "OPTIONS")
    return new Response("ok", { headers: tracedHeaders });
  if (request.method !== "POST")
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: tracedHeaders },
    );
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer "))
    return Response.json(
      { error: "authentication_required" },
      { status: 401, headers: tracedHeaders },
    );
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey)
    return Response.json(
      { error: "service_not_configured" },
      { status: 503, headers: tracedHeaders },
    );
  const body = await request.json().catch(() => null);
  if (
    !body?.deviceId ||
    !body?.tenantId ||
    !body?.branchId ||
    !Array.isArray(body?.mutations) ||
    body.mutations.length > 100
  ) {
    return Response.json(
      { error: "invalid_sync_batch" },
      { status: 400, headers: tracedHeaders },
    );
  }
  for (const mutation of body.mutations as Record<string, unknown>[]) {
    if (mutation.schemaVersion !== 1 && mutation.schemaVersion !== 2)
      return Response.json({ error: "unsupported_schema_version", supportedSchemaVersions: [1, 2],traceId:trace.traceId }, { status: 426, headers: tracedHeaders });
    if (mutation.schemaVersion === 2) {
      if (typeof mutation.payloadHash !== "string" || mutation.payloadHash !== await sha256(mutation.payload))
        return Response.json({ error: "payload_integrity_failed", mutationId: mutation.mutationId,traceId:trace.traceId }, { status: 422, headers: tracedHeaders });
    }
  }
  const coreMutations = body.mutations.filter(
    (mutation: { aggregateType?: string; operation?: string }) =>
      mutation.aggregateType === "sale" ||
      (mutation.aggregateType === "product" &&
        mutation.operation !== "archive"),
  );
  const extendedMutations = body.mutations.filter(
    (mutation: { aggregateType?: string; operation?: string }) =>
      !(
        mutation.aggregateType === "sale" ||
        (mutation.aggregateType === "product" &&
          mutation.operation !== "archive")
      ),
  );
  const callRpc = async (name: string, mutations: unknown[]) => {
    if (!mutations.length) return { receipts: [] };
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: authorization,
        "Content-Type": "application/json",
        ...traceHeaders(trace),
      },
      body: JSON.stringify({ client_device_id: body.deviceId, mutations }),
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
  };
  let core: { receipts?: unknown[] }, extended: { receipts?: unknown[] };
  try {
    extended = await callRpc("apply_extended_sync_batch", extendedMutations);
    core = await callRpc("apply_sync_batch", coreMutations);
  } catch (error) {
    return Response.json(
      {
        error: "sync_apply_failed",
        detail: error instanceof Error ? error.message : "unknown",
      },
      { status: 409, headers: tracedHeaders },
    );
  }
  const cursor = Number(body.cursor ?? 0);
  const deltasResponse = await fetch(
    `${url}/rest/v1/sync_mutations?tenant_id=eq.${encodeURIComponent(body.tenantId)}&branch_id=eq.${encodeURIComponent(body.branchId)}&sequence_id=gt.${cursor}&order=sequence_id.asc&limit=200&select=sequence_id,aggregate_type,aggregate_id,operation,payload,occurred_at,actor_id,business_id,branch_id,device_id`,
    { headers: { apikey: anonKey, Authorization: authorization,...traceHeaders(trace) } },
  );
  if (!deltasResponse.ok)
    return new Response(await deltasResponse.text(), {
      status: deltasResponse.status,
      headers: tracedHeaders,
    });
  const deltas = await deltasResponse.json();
  const nextCursor = deltas.length
    ? String(deltas[deltas.length - 1].sequence_id)
    : String(cursor);
  const normalizeReceipt = (receipt: unknown) => {
    if (!receipt || typeof receipt !== "object") return receipt;
    const value = receipt as { status?: string; errorCode?: string };
    return value.status === "rejected" && String(value.errorCode ?? "").includes("version_conflict")
      ? { ...value, status: "conflict" }
      : value;
  };
  const receipts = [...(core.receipts ?? []), ...(extended.receipts ?? [])].map(normalizeReceipt) as {
    mutationId?: string; status?: string; errorCode?: string;
  }[];
  for (const receipt of receipts) {
    if (!receipt.mutationId || !["conflict", "rejected"].includes(String(receipt.status))) continue;
    const mutation = (body.mutations as Record<string, unknown>[]).find((item) => item.mutationId === receipt.mutationId);
    if (!mutation) continue;
    const recorded = await fetch(`${url}/rest/v1/rpc/record_sync_review`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: authorization, "Content-Type": "application/json",...traceHeaders(trace) },
      body: JSON.stringify({
        client_device_id: body.deviceId,
        mutation,
        receipt_status: receipt.status,
        receipt_error_code: receipt.errorCode ?? null,
      }),
    });
    if (!recorded.ok) {
      return Response.json({ error: "sync_review_persistence_failed", mutationId: receipt.mutationId,traceId:trace.traceId }, { status: 500, headers: tracedHeaders });
    }
  }
  return Response.json(
    {
      receipts,
      deltas,
      nextCursor,
      supportedSchemaVersions: [1, 2],
      serverTime: new Date().toISOString(),
      traceId:trace.traceId,
    },
    { headers: tracedHeaders },
  );
});
