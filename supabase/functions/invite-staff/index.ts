import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const response = (body: Record<string, unknown>, status = 200) => Response.json(body, { status, headers: cors });

async function readBody(result: Response): Promise<unknown> {
  const text = await result.text();
  try { return JSON.parse(text) as unknown; }
  catch { return { message: text || `HTTP ${result.status}` }; }
}

function messageOf(body: unknown) {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const value = body as Record<string, unknown>;
    return String(value.message ?? value.error_description ?? value.error ?? "");
  }
  return String(body ?? "");
}

async function revokeInvitation(url: string, serviceKey: string, invitationId: string, requestId: string, reason: string) {
  const revoked = await fetch(`${url}/rest/v1/staff_invitations?id=eq.${encodeURIComponent(invitationId)}`, {
    method: "PATCH",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ status: "revoked", updated_at: new Date().toISOString() }),
  });
  if (!revoked.ok) console.error(JSON.stringify({ requestId, stage: "revoke_failed_invitation", status: revoked.status, reason }));
}

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return response({ error: "method_not_allowed", requestId }, 405);

  try {
    const authorization = request.headers.get("Authorization");
    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const appUrl = Deno.env.get("APP_DEEP_LINK_URL") ?? "niagacore://auth/callback";
    const recoveryUrl = Deno.env.get("APP_PASSWORD_RESET_DEEP_LINK_URL") ?? "niagacore://auth/reset";
    if (!authorization || !url || !anonKey || !serviceKey) {
      console.error(JSON.stringify({ requestId, stage: "configuration", error: "not_configured" }));
      return response({ error: "not_configured", requestId }, 503);
    }

    const body = await request.json().catch(() => null);
    const email = String(body?.email ?? "").trim().toLowerCase();
    const role = String(body?.role ?? "");
    const branchIds = Array.isArray(body?.branchIds) ? body.branchIds.map(String) : [];
    const merchantName = String(body?.merchantName ?? "NiagaCore").trim().slice(0, 120) || "NiagaCore";
    const allowedRoles = [
      "business_manager", "branch_manager", "supervisor", "cashier", "warehouse",
      "purchasing", "finance", "service_staff", "kitchen", "waiter", "auditor",
    ];
    if (!/^\S+@\S+\.\S+$/.test(email) || !allowedRoles.includes(role) || branchIds.length === 0) {
      return response({ error: "invalid_invitation", requestId }, 400);
    }

    const rpc = await fetch(`${url}/rest/v1/rpc/create_staff_invitation`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ target_email: email, target_role: role, target_branch_ids: branchIds }),
    });
    const rpcBody = await readBody(rpc);
    if (!rpc.ok) {
      const serverMessage = messageOf(rpcBody) || "staff_invitation_rejected";
      const known = ["mfa_required", "owner_required", "pending_email", "invalid_branch_access", "invalid_invitation"].find((code) => serverMessage.includes(code));
      console.error(JSON.stringify({ requestId, stage: "create_invitation", status: rpc.status, error: known ?? "database_error", detail: serverMessage }));
      return response({ error: known ?? "database_error", detail: serverMessage, requestId }, rpc.status);
    }
    const invitationId = String(rpcBody).replace(/^"|"$/g, "");

    const invite = await fetch(`${url}/auth/v1/invite?redirect_to=${encodeURIComponent(appUrl)}`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, data: { staff_invitation_id: invitationId, merchant_name: merchantName, staff_role: role } }),
    });
    const provider = await readBody(invite);
    if (!invite.ok) {
      const providerMessage = messageOf(provider) || "auth_invitation_failed";
      if (invite.status === 422 || /already|registered|exists/i.test(providerMessage)) {
        const recovery = await fetch(`${url}/auth/v1/recover?redirect_to=${encodeURIComponent(recoveryUrl)}`, {
          method: "POST",
          headers: { apikey: anonKey, "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const recoveryBody = await readBody(recovery);
        if (!recovery.ok) {
          const recoveryMessage = messageOf(recoveryBody) || "existing_account_email_failed";
          await revokeInvitation(url, serviceKey, invitationId, requestId, recoveryMessage);
          console.error(JSON.stringify({ requestId, stage: "existing_account_email", status: recovery.status, error: "existing_account_email_failed", detail: recoveryMessage }));
          return response({ error: "existing_account_email_failed", detail: recoveryMessage, requestId }, recovery.status);
        }
        console.log(JSON.stringify({ requestId, stage: "provider_accepted", status: "existing_account_recovery_requested" }));
        return response({ invitationId, status: "existing_account_recovery_requested", requestId });
      }
      await revokeInvitation(url, serviceKey, invitationId, requestId, providerMessage);
      console.error(JSON.stringify({ requestId, stage: "send_email", status: invite.status, error: "auth_invitation_failed", detail: providerMessage }));
      return response({ error: "auth_invitation_failed", detail: providerMessage, requestId }, invite.status);
    }
    console.log(JSON.stringify({ requestId, stage: "provider_accepted", status: "invite_requested" }));
    return response({ invitationId, status: "invite_requested", requestId });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ requestId, stage: "unexpected", error: "internal_error", detail }));
    return response({ error: "internal_error", detail, requestId }, 500);
  }
});
