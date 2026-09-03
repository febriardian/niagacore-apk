import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createTraceContext,finishObservedJob,startObservedJob,traceHeaders} from "../_shared/observability.ts";
import {evaluationContext,scoreNiaEvaluation,type EvaluationCase} from "../_shared/nia-evaluation.ts";

const jsonHeaders={"Content-Type":"application/json"};
type Schedule={id:string;suite:string;provider_order:string[];interval_hours:number};
type PreviousRun={grounding_score:number|null;regression_score:number|null};

async function gemini(question:string,context:string,traceparent:string){
  const key=Deno.env.get("GEMINI_API_KEY");if(!key)throw new Error("gemini_not_configured");
  const model=Deno.env.get("GEMINI_MODEL")??"gemini-2.5-flash-lite",response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,{method:"POST",headers:{...jsonHeaders,traceparent},body:JSON.stringify({contents:[{role:"user",parts:[{text:`Jawab singkat hanya berdasarkan konteks terverifikasi. Pertanyaan: ${question}\nKonteks: ${context}`}]}],generationConfig:{temperature:0,maxOutputTokens:300}})}),body=await response.json();
  if(!response.ok)throw new Error("gemini_request_failed");
  return{model,answer:String(body?.candidates?.[0]?.content?.parts?.map((item:{text?:string})=>item.text??"").join("")??"").trim()};
}
async function cloudflare(question:string,context:string,traceparent:string){
  const account=Deno.env.get("CLOUDFLARE_ACCOUNT_ID"),token=Deno.env.get("CLOUDFLARE_API_TOKEN");if(!account||!token)throw new Error("cloudflare_not_configured");
  const model=Deno.env.get("CLOUDFLARE_AI_MODEL")??"@cf/meta/llama-3.1-8b-instruct",response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,{method:"POST",headers:{...jsonHeaders,Authorization:`Bearer ${token}`,traceparent},body:JSON.stringify({messages:[{role:"system",content:"Jawab singkat hanya berdasarkan konteks terverifikasi. Jangan membuat fakta baru."},{role:"user",content:`Pertanyaan: ${question}\nKonteks: ${context}`}],temperature:0,max_tokens:300})}),body=await response.json();
  if(!response.ok)throw new Error("cloudflare_request_failed");
  return{model,answer:String(body?.result?.response??"").trim()};
}
async function rest(url:string,key:string,path:string,init?:RequestInit){
  const response=await fetch(`${url}/rest/v1/${path}`,{...init,headers:{apikey:key,Authorization:`Bearer ${key}`,...jsonHeaders,...(init?.headers??{})}});
  if(!response.ok)throw new Error(`${path.split("?")[0]}_${response.status}`);
  if(response.status===204)return null;
  const text=await response.text();return text?JSON.parse(text):null;
}

Deno.serve(async request=>{
  const trace=createTraceContext(request),responseHeaders={...jsonHeaders,...traceHeaders(trace)};
  if(request.method!=="POST")return Response.json({error:"method_not_allowed",traceId:trace.traceId},{status:405,headers:responseHeaders});
  const secret=Deno.env.get("NIA_EVALUATION_CRON_SECRET"),provided=request.headers.get("x-nia-cron-secret");
  if(!secret||provided!==secret)return Response.json({error:"unauthorized",traceId:trace.traceId},{status:401,headers:responseHeaders});
  const requestBody=await request.json().catch(()=>({})) as {source?:string;force?:boolean};
  const force=requestBody.force===true&&requestBody.source==="github-manual";
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!url||!key)return Response.json({error:"backend_not_configured",traceId:trace.traceId},{status:500,headers:responseHeaders});
  const jobId=await startObservedJob({url,serviceKey:key,trace,jobName:"nia.evaluator",triggerSource:force?"manual":"schedule",metadata:{contract:"nia-evaluation/v1",force}});
  try{
  const businesses=await rest(url,key,"businesses?select=id,tenant_id") as {id:string;tenant_id:string}[];
  const calibration:{businessId:string;ok:boolean}[]=[];
  for(const business of businesses??[]){
    try{await rest(url,key,"rpc/calibrate_nia_anomaly_thresholds",{method:"POST",body:JSON.stringify({target_tenant_id:business.tenant_id,target_business_id:business.id,lookback_days:90})});calibration.push({businessId:business.id,ok:true});}
    catch{calibration.push({businessId:business.id,ok:false});}
  }
  const scheduleFilter=force?"nia_evaluation_schedules?active=eq.true":"nia_evaluation_schedules?active=eq.true&next_run_at=lte.now()";
  const schedules=await rest(url,key,`${scheduleFilter}&select=id,suite,provider_order,interval_hours`) as Schedule[];
  const summary:{suite:string;provider:string;status:string;passed:number;total:number;providerErrors:number}[]=[];
  for(const schedule of schedules??[]){
    const cases=await rest(url,key,`nia_evaluation_cases?suite=eq.${encodeURIComponent(schedule.suite)}&active=eq.true&select=id,question,expected_intent,reference_answer,required_facts,forbidden_claims`) as EvaluationCase[];
    for(const provider of schedule.provider_order){
      const previousRows=await rest(url,key,`nia_evaluation_runs?suite=eq.${encodeURIComponent(schedule.suite)}&provider=eq.${encodeURIComponent(provider)}&status=neq.running&order=started_at.desc&limit=1&select=grounding_score,regression_score`) as PreviousRun[];
      const previous=previousRows?.[0];
      const provisional=await rest(url,key,"nia_evaluation_runs",{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify({schedule_id:schedule.id,suite:schedule.suite,provider,model:"pending",total_cases:cases.length})}) as {id:string}[];
      const runId=provisional[0]?.id;if(!runId)continue;
      let passed=0,groundingTotal=0,referenceTotal=0,model="not_available",providerErrors=0;
      const providerErrorCodes=new Set<string>();
      for(const test of cases){
        let answer="",diagnostics:Record<string,unknown>={};
        const context=evaluationContext(test);
        try{const output=provider==="gemini"?await gemini(test.question,context,trace.traceparent):await cloudflare(test.question,context,trace.traceparent);answer=output.answer;model=output.model;}catch(error){const code=error instanceof Error?error.message:"provider_failed";providerErrors++;providerErrorCodes.add(code);diagnostics={error:code,traceId:trace.traceId};}
        const result=scoreNiaEvaluation(test,answer);if(result.passed)passed++;groundingTotal+=result.grounding;referenceTotal+=result.reference;
        await rest(url,key,"nia_evaluation_results",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({run_id:runId,case_id:test.id,passed:result.passed,intent_match:result.intentMatch,grounding_score:result.grounding,reference_score:result.reference,forbidden_claims_found:result.found,answer,diagnostics})});
      }
      const total=cases.length,groundingScore=total?groundingTotal/total:0,referenceScore=total?referenceTotal/total:0;
      const previousReference=previous?.regression_score===null||previous?.regression_score===undefined?null:Number(previous.regression_score),regressionDelta=previousReference===null?null:referenceScore-previousReference,regressionPassed=regressionDelta===null||regressionDelta>=-.10;
      const caseStatus=total>0&&passed===total?"passed":passed>0?"partial":"failed",status=regressionPassed?caseStatus:caseStatus==="failed"?"failed":"partial";
      await rest(url,key,`nia_evaluation_runs?id=eq.${runId}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({model,status,total_cases:total,passed_cases:passed,grounding_score:groundingScore,regression_score:referenceScore,completed_at:new Date().toISOString(),metadata:{providerErrors,providerErrorCodes:[...providerErrorCodes],evaluatedCases:Math.max(0,total-providerErrors),previousGroundingScore:previous?.grounding_score??null,previousReferenceScore:previousReference,regressionDelta,regressionPassed}})});
      summary.push({suite:schedule.suite,provider,status,passed,total,providerErrors});
    }
    const next=new Date(Date.now()+Math.max(1,schedule.interval_hours)*3_600_000).toISOString();
    await rest(url,key,`nia_evaluation_schedules?id=eq.${schedule.id}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({last_run_at:new Date().toISOString(),next_run_at:next})});
  }
  const qualityPassed=summary.filter(item=>item.status==="passed").length,qualityPartial=summary.filter(item=>item.status==="partial").length,qualityFailed=summary.length-qualityPassed-qualityPartial;
  const processFailed=summary.filter(item=>item.total>0&&item.providerErrors===item.total).length,processSucceeded=summary.length-processFailed;
  await finishObservedJob({url,serviceKey:key,trace,jobId,status:processFailed===0?"succeeded":processSucceeded?"partial":"failed",counts:{processed:summary.length,succeeded:processSucceeded,failed:processFailed},attributes:{businesses:businesses.length,calibrations:calibration.length,qualityPassed,qualityPartial,qualityFailed}});
  return Response.json({ok:true,forced:force,calibration,runs:summary,traceId:trace.traceId},{headers:responseHeaders});
  }catch(error){
    await finishObservedJob({url,serviceKey:key,trace,jobId,status:"failed",error});
    return Response.json({error:"nia_evaluation_failed",detail:error instanceof Error?error.message:"unknown",traceId:trace.traceId},{status:500,headers:responseHeaders});
  }
});
