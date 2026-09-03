import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const jsonHeaders={"Content-Type":"application/json"};
Deno.serve(async(request)=>{
  if(request.method!=="POST") return Response.json({error:"method_not_allowed"},{status:405});
  const authorization=request.headers.get("Authorization");
  const url=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const serverKey=Deno.env.get("MIDTRANS_SERVER_KEY"),environment=Deno.env.get("MIDTRANS_ENVIRONMENT")?.trim().toLowerCase();
  if(!authorization||!url||!anon) return Response.json({error:"authentication_required"},{status:401});
  if(!serverKey||!service||environment!=="production") return Response.json({error:"midtrans_not_configured"},{status:503});
  const body=await request.json().catch(()=>null);
  const retryingAsAdmin=typeof body?.adminRefundId==="string";
  const approvingPending=typeof body?.pendingRefundId==="string";
  if(!retryingAsAdmin&&!approvingPending&&(!body?.saleId||!body?.refundId||!Number.isInteger(body?.amount)||body.amount<=0||typeof body.reason!=="string"))
    return Response.json({error:"invalid_refund_request"},{status:400});
  const rpc=retryingAsAdmin?"admin_prepare_refund_retry":approvingPending?"prepare_approved_midtrans_refund":"request_midtrans_refund";
  const prepared=await fetch(`${url}/rest/v1/rpc/${rpc}`,{
    method:"POST",headers:{apikey:anon,Authorization:authorization,...jsonHeaders},
    body:JSON.stringify(retryingAsAdmin?{target_refund_id:body.adminRefundId}:approvingPending?{target_refund_id:body.pendingRefundId}:{target_sale_id:body.saleId,refund_id:body.refundId,refund_amount:body.amount,refund_reason:body.reason,stock_disposition:body.stockDisposition??"restock"})
  });
  if(!prepared.ok) return new Response(await prepared.text(),{status:prepared.status,headers:jsonHeaders});
  const refund=await prepared.json();
  const base="https://api.midtrans.com";
  const provider=await fetch(`${base}/v2/${encodeURIComponent(refund.orderId)}/refund`,{method:"POST",headers:{Authorization:`Basic ${btoa(`${serverKey}:`)}`,...jsonHeaders,Accept:"application/json"},body:JSON.stringify({refund_key:refund.refundId,amount:refund.amount,reason:refund.reason})});
  const payload=await provider.json().catch(()=>({status_message:"invalid_provider_response"}));
  if(!provider.ok) return Response.json({error:"midtrans_refund_failed",provider:payload},{status:provider.status});
  const finalized=await fetch(`${url}/rest/v1/rpc/finalize_midtrans_refund`,{method:"POST",headers:{apikey:service,Authorization:`Bearer ${service}`,...jsonHeaders},body:JSON.stringify({refund_reference:refund.refundId,provider_status:payload.refund_status??payload.transaction_status??"success",provider_payload:payload})});
  return new Response(await finalized.text(),{status:finalized.ok?200:500,headers:jsonHeaders});
});
