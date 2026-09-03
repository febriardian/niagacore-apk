import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createTraceContext,traceHeaders} from "../_shared/observability.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

type SaleLine = { productId: string; quantity: number; discountMinor?: number };
type MidtransAction = { name?: string; url?: string };
type MidtransPayload = Record<string, unknown> & {
  actions?: MidtransAction[];
  qris?: Record<string, unknown>;
  status_code?: string;
  status_message?: string;
  transaction_status?: string;
  transaction_id?: string;
  payment_type?: string;
};
type SnapPayload={token?:string;redirect_url?:string;status_code?:string;status_message?:string};

const value=(input:unknown)=>typeof input==="string"&&input.trim()?input.trim():null;
function extractQris(provider:MidtransPayload){
  const actions=Array.isArray(provider.actions)?provider.actions:[];
  const qrString=value(provider.qr_string)??value(provider.qrString)??value(provider.qr_code)??value(provider.qris?.qr_string);
  const qrAction=actions.find(action=>["generate-qr-code","generate-qr-code-v2"].includes((action.name??"").trim().toLowerCase().replaceAll("_","-")));
  return{qrString,qrImageUrl:value(qrAction?.url),actionNames:actions.map(action=>action.name).filter((name):name is string=>Boolean(name))};
}
const qrModeUrl=(url:string)=>`${url}${url.includes("?")?"&":"?"}gopayMode=qr`;

Deno.serve(async (request) => {
  const trace=createTraceContext(request),tracedHeaders={...cors,...traceHeaders(trace)};
  if (request.method === "OPTIONS") return new Response("ok", { headers: tracedHeaders });
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed",traceId:trace.traceId }, { status: 405, headers: tracedHeaders });
  }

  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const serverKey = Deno.env.get("MIDTRANS_SERVER_KEY");
  const environment = Deno.env.get("MIDTRANS_ENVIRONMENT")?.trim().toLowerCase();
  if (!authorization || !url || !anonKey) {
    return Response.json({ error: "authentication_required",traceId:trace.traceId }, { status: 401, headers: tracedHeaders });
  }
  if (!serverKey || environment !== "production" || !serviceKey) {
    return Response.json({ error: "midtrans_not_configured",traceId:trace.traceId }, { status: 503, headers: tracedHeaders });
  }

  const body = await request.json().catch(() => null);
  if (
    !body?.saleId || !body?.branchId || !body?.deviceId ||
    !body?.receiptNumber || !Array.isArray(body?.lines)
  ) {
    return Response.json({ error: "invalid_payment_request",traceId:trace.traceId }, { status: 400, headers: tracedHeaders });
  }

  const saleResponse = await fetch(`${url}/rest/v1/rpc/create_qris_sale`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: authorization, "Content-Type": "application/json",...traceHeaders(trace) },
    body: JSON.stringify({
      sale_id: body.saleId,
      target_branch_id: body.branchId,
      client_device_id: body.deviceId,
      customer_id: body.customerId ?? null,
      target_shift_id: body.shiftId,
      receipt_number: body.receiptNumber,
      lines: (body.lines as SaleLine[]).map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        discountMinor: Math.max(0, Math.round(line.discountMinor ?? 0)),
      })),
    }),
  });
  if (!saleResponse.ok) {
    return new Response(await saleResponse.text(), { status: saleResponse.status, headers: tracedHeaders });
  }
  const sale = await saleResponse.json();

  const failInitialization=async(errorCode:string,providerStatus:string|null,diagnostics:Record<string,unknown>)=>{
    const cleanup=await fetch(`${url}/rest/v1/rpc/fail_qris_payment_initialization_server`,{
      method:"POST",
      headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,"Content-Type":"application/json",...traceHeaders(trace)},
      body:JSON.stringify({target_sale_id:sale.saleId,error_code:errorCode,target_provider_status:providerStatus,target_diagnostics:diagnostics}),
    });
    if(!cleanup.ok)throw new Error(`qris_cleanup_failed:${cleanup.status}:${(await cleanup.text()).slice(0,200)}`);
  };

  const endpoint = "https://api.midtrans.com/v2/charge";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${serverKey}:`)}`,
      ...traceHeaders(trace),
    },
    body: JSON.stringify({
      payment_type: "qris",
      transaction_details: { order_id: sale.orderId, gross_amount: sale.amount },
      item_details: sale.items,
      custom_field1: sale.saleId,
      custom_field2: sale.tenantId,
      expiry: { unit: "minute", duration: 15 },
    }),
  });
  const rawProvider=await response.text();
  let provider:MidtransPayload;
  try{provider=JSON.parse(rawProvider) as MidtransPayload}catch{provider={error:"invalid_midtrans_response"}}
  const extracted=extractQris(provider);
  const diagnostics:Record<string,unknown>={
    httpStatus:response.status,
    statusCode:value(provider.status_code),
    transactionStatus:value(provider.transaction_status),
    statusMessage:value(provider.status_message),
    paymentType:value(provider.payment_type),
    actionNames:extracted.actionNames,
    requestedPaymentType:"qris",
    responseFormat:rawProvider.trim().startsWith("{")?"json":"non_json",
    traceId:trace.traceId,
  };
  const providerAccepted=response.ok&&diagnostics.statusCode==="201";
  if (!providerAccepted) {
    const channelInactive=diagnostics.statusCode==="402"&&/(channel|payment type).*(not activated|doesn.t have access)/i.test(String(diagnostics.statusMessage??""));
    if(channelInactive){
      const snapResponse=await fetch("https://app.midtrans.com/snap/v1/transactions",{
        method:"POST",
        headers:{"Content-Type":"application/json",Accept:"application/json",Authorization:`Basic ${btoa(`${serverKey}:`)}`,...traceHeaders(trace)},
        body:JSON.stringify({
          transaction_details:{order_id:sale.orderId,gross_amount:sale.amount},
          item_details:sale.items,
          enabled_payments:["gopay"],
          custom_field1:sale.saleId,
          custom_field2:sale.tenantId,
          expiry:{unit:"minute",duration:15},
        }),
      });
      const snap=await snapResponse.json().catch(()=>({})) as SnapPayload;
      const paymentUrl=typeof snap.redirect_url==="string"&&snap.redirect_url.startsWith("https://app.midtrans.com/")?qrModeUrl(snap.redirect_url):null;
      if(snapResponse.ok&&paymentUrl){
        const expiresAt=new Date(Date.now()+15*60_000).toISOString();
        const attached=await fetch(`${url}/rest/v1/rpc/attach_qris_payment_session_v2`,{
          method:"POST",
          headers:{apikey:anonKey,Authorization:authorization,"Content-Type":"application/json",...traceHeaders(trace)},
          body:JSON.stringify({target_sale_id:sale.saleId,target_order_id:sale.orderId,target_qr_string:null,target_qr_image_url:null,target_payment_url:paymentUrl,target_expires_at:expiresAt,target_provider_payload:{mode:"snap_qris_fallback",core:provider,snap}}),
        });
        if(!attached.ok)return Response.json({error:"qris_session_persistence_failed",traceId:trace.traceId},{status:500,headers:tracedHeaders});
        console.info(JSON.stringify({event:"qris_snap_fallback_created",orderId:sale.orderId,traceId:trace.traceId}));
        return Response.json({saleId:sale.saleId,tenantId:sale.tenantId,orderId:sale.orderId,receiptNumber:sale.receiptNumber,amount:sale.amount,currency:"IDR",status:"pending",qrString:null,qrImageUrl:null,paymentUrl,expiresAt,traceId:trace.traceId,checkoutMode:"snap_qris"},{headers:tracedHeaders});
      }
      diagnostics.snapStatusCode=value(snap.status_code)??String(snapResponse.status);
      diagnostics.snapStatusMessage=value(snap.status_message);
    }
    const errorCode=channelInactive?"qris_channel_not_activated":"midtrans_charge_failed";
    try{await failInitialization(errorCode,value(diagnostics.transactionStatus),diagnostics)}catch(error){console.error(JSON.stringify({event:"qris_cleanup_failed",orderId:sale.orderId,message:error instanceof Error?error.message:"unknown",...diagnostics}))}
    console.error(JSON.stringify({event:errorCode,orderId:sale.orderId,...diagnostics}));
    return Response.json({error:errorCode,diagnostics,traceId:trace.traceId},{status:channelInactive?503:502,headers:tracedHeaders});
  }

  const {qrString,qrImageUrl,actionNames}=extracted;
  if (!qrString && !qrImageUrl) {
    console.error(JSON.stringify({event:"qris_payload_missing",orderId:sale.orderId,...diagnostics}));
    try{await failInitialization("qris_payload_missing",value(diagnostics.transactionStatus),diagnostics)}catch(error){console.error(JSON.stringify({event:"qris_cleanup_failed",orderId:sale.orderId,message:error instanceof Error?error.message:"unknown",...diagnostics}))}
    return Response.json({ error: "qris_payload_missing",diagnostics,traceId:trace.traceId }, { status: 502, headers: tracedHeaders });
  }
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const attached = await fetch(`${url}/rest/v1/rpc/attach_qris_payment_session_v2`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: authorization, "Content-Type": "application/json",...traceHeaders(trace) },
    body: JSON.stringify({
      target_sale_id: sale.saleId,
      target_order_id: sale.orderId,
      target_qr_string: qrString,
      target_qr_image_url: qrImageUrl,
      target_payment_url: null,
      target_expires_at: expiresAt,
      target_provider_payload: provider,
    }),
  });
  if (!attached.ok) {
    return Response.json({ error: "qris_session_persistence_failed",traceId:trace.traceId }, { status: 500, headers: tracedHeaders });
  }

  return Response.json({
    saleId: sale.saleId,
    tenantId: sale.tenantId,
    orderId: sale.orderId,
    receiptNumber: sale.receiptNumber,
    amount: sale.amount,
    currency: "IDR",
    status: provider.transaction_status ?? "pending",
    qrString,
    qrImageUrl,
    expiresAt,
    traceId:trace.traceId,
  }, { headers: tracedHeaders });
});
