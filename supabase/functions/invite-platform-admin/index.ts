import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const headers={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info"};
const respond=(body:Record<string,unknown>,status=200)=>Response.json(body,{status,headers});

Deno.serve(async(request)=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers});
  if(request.method!=="POST")return respond({error:"method_not_allowed"},405);
  const authorization=request.headers.get("Authorization");
  const url=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!authorization||!url||!anon||!service)return respond({error:"backend_not_configured"},503);
  const body=await request.json().catch(()=>null);
  if(typeof body?.email!=="string"||typeof body?.role!=="string"||typeof body?.note!=="string")return respond({error:"invalid_invitation"},400);
  const created=await fetch(`${url}/rest/v1/rpc/admin_create_platform_admin_invitation`,{method:"POST",headers:{apikey:anon,Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({target_email:body.email,target_role:body.role,target_note:body.note})});
  if(!created.ok){const detail=await created.json().catch(()=>null);return respond({error:String(detail?.message??"invitation_create_failed")},created.status);}
  const invitationId=await created.json();
  const invited=await fetch(`${url}/auth/v1/invite`,{method:"POST",headers:{apikey:service,Authorization:`Bearer ${service}`,"Content-Type":"application/json"},body:JSON.stringify({email:body.email,data:{platform_admin_invitation_id:invitationId,platform_admin_role:body.role}})});
  if(!invited.ok){await invited.text();await fetch(`${url}/rest/v1/rpc/fail_platform_admin_invitation`,{method:"POST",headers:{apikey:service,Authorization:`Bearer ${service}`,"Content-Type":"application/json"},body:JSON.stringify({target_invitation_id:invitationId,target_error_code:`auth_invite_${invited.status}`})});return respond({error:invited.status===422?"email_already_registered":"invitation_delivery_failed"},invited.status);}
  const user=await invited.json();
  const completed=await fetch(`${url}/rest/v1/rpc/complete_platform_admin_invitation`,{method:"POST",headers:{apikey:service,Authorization:`Bearer ${service}`,"Content-Type":"application/json"},body:JSON.stringify({target_invitation_id:invitationId,target_user_id:user.id})});
  if(!completed.ok)return respond({error:"invitation_state_update_failed"},500);
  return respond({ok:true,invitationId,status:"sent"});
});
