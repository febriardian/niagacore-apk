import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const headers={"Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":"*"};
async function fetchWithTimeout(input:string,init:RequestInit={}){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
  try{return await fetch(input,{...init,signal:controller.signal})}finally{clearTimeout(timeout)}
}
Deno.serve(async(request)=>{
  const started=performance.now();
  if(!["GET","POST"].includes(request.method))return Response.json({status:"error",code:"method_not_allowed"},{status:405,headers});
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)return Response.json({status:"degraded",checks:{configuration:"failed"}},{status:503,headers});
  try{
    const response=await fetchWithTimeout(`${url}/rest/v1/platform_payment_configuration?select=payment_model,environment&limit=1`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});
    const healthy=response.ok;
    const serverKey=Deno.env.get("MIDTRANS_SERVER_KEY"),paymentConfigured=Boolean(serverKey)&&Deno.env.get("MIDTRANS_ENVIRONMENT")?.toLowerCase()==="production";
    let paymentAuthentication="not_configured";
    if(paymentConfigured&&serverKey)try{
      const authResponse=await fetchWithTimeout(`https://api.midtrans.com/v2/niagacore-health-${crypto.randomUUID()}/status`,{headers:{Accept:"application/json",Authorization:`Basic ${btoa(`${serverKey}:`)}`}});
      const authBody=await authResponse.json().catch(()=>({})) as{status_code?:string};
      paymentAuthentication=authResponse.status===401||authResponse.status===403||["401","403"].includes(String(authBody.status_code??""))?"failed":"authenticated";
    }catch{paymentAuthentication="unreachable"}
    const geminiConfigured=Boolean(Deno.env.get("GEMINI_API_KEY"));
    const cloudflareConfigured=Boolean(Deno.env.get("CLOUDFLARE_ACCOUNT_ID"))&&Boolean(Deno.env.get("CLOUDFLARE_API_TOKEN"));
    const evaluatorConfigured=Boolean(Deno.env.get("NIA_EVALUATION_CRON_SECRET"));
    const operational=healthy&&paymentAuthentication==="authenticated";
    console.log(JSON.stringify({event:"health_check",operational,database:healthy,paymentConfigured,paymentAuthentication,latencyMs:Math.round(performance.now()-started)}));
    return Response.json({status:operational?"operational":"degraded",checkedAt:new Date().toISOString(),latencyMs:Math.round(performance.now()-started),checks:{api:"operational",database:healthy?"operational":"failed",midtransConfiguration:paymentConfigured?"configured":"failed",midtransAuthentication:paymentAuthentication,qrisCapability:paymentAuthentication==="authenticated"?"transaction_test_required":"unavailable",niaProvider:geminiConfigured||cloudflareConfigured?"configured":"failed",niaEvaluator:evaluatorConfigured?"configured":"failed"}},{status:operational?200:503,headers});
  }catch(error){
    console.error(JSON.stringify({event:"health_check_failed",message:error instanceof Error?error.message:"unknown"}));
    return Response.json({status:"degraded",checkedAt:new Date().toISOString(),checks:{api:"operational",database:"failed"}},{status:503,headers});
  }
});
