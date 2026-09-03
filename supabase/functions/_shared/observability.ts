export type TraceContext={traceId:string;spanId:string;parentSpanId:string|null;traceparent:string;startedAt:string;startedMs:number};
const hex=(bytes:number)=>[...crypto.getRandomValues(new Uint8Array(bytes))].map(value=>value.toString(16).padStart(2,"0")).join("");
export function createTraceContext(request:Request):TraceContext{
  const incoming=request.headers.get("traceparent")?.trim().toLowerCase();
  const match=incoming?.match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/);
  const traceId=match?.[1]&&!/^0+$/.test(match[1])?match[1]:hex(16),parentSpanId=match?.[2]&&!/^0+$/.test(match[2])?match[2]:null,spanId=hex(8);
  return{traceId,spanId,parentSpanId,traceparent:`00-${traceId}-${spanId}-01`,startedAt:new Date().toISOString(),startedMs:performance.now()};
}
export const traceHeaders=(trace:TraceContext)=>({traceparent:trace.traceparent,"x-trace-id":trace.traceId});
type JobCounts={processed?:number;succeeded?:number;failed?:number};
export async function startObservedJob(input:{url:string;serviceKey:string;trace:TraceContext;jobName:string;triggerSource:string;tenantId?:string|null;businessId?:string|null;branchId?:string|null;metadata?:Record<string,unknown>}){
  const response=await fetch(`${input.url}/rest/v1/observability_job_runs`,{method:"POST",headers:{apikey:input.serviceKey,Authorization:`Bearer ${input.serviceKey}`,"Content-Type":"application/json",Prefer:"return=representation",...traceHeaders(input.trace)},body:JSON.stringify({tenant_id:input.tenantId??null,business_id:input.businessId??null,branch_id:input.branchId??null,job_name:input.jobName,trigger_source:input.triggerSource,trace_id:input.trace.traceId,root_span_id:input.trace.spanId,metadata:input.metadata??{}})});
  if(!response.ok)return null;const rows=await response.json();return typeof rows?.[0]?.id==="string"?rows[0].id:null;
}
export async function finishObservedJob(input:{url:string;serviceKey:string;trace:TraceContext;jobId:string|null;status:"succeeded"|"partial"|"failed";counts?:JobCounts;error?:unknown;attributes?:Record<string,unknown>}){
  if(!input.jobId)return;
  const completedAt=new Date().toISOString(),durationMs=Math.max(0,Math.round(performance.now()-input.trace.startedMs)),message=input.error instanceof Error?input.error.message:input.error?String(input.error):null;
  const auth={apikey:input.serviceKey,Authorization:`Bearer ${input.serviceKey}`,"Content-Type":"application/json",...traceHeaders(input.trace)};
  await fetch(`${input.url}/rest/v1/observability_job_runs?id=eq.${input.jobId}`,{method:"PATCH",headers:auth,body:JSON.stringify({status:input.status,processed_count:input.counts?.processed??0,succeeded_count:input.counts?.succeeded??0,failed_count:input.counts?.failed??0,error_code:message?.slice(0,120)??null,error_message:message?.slice(0,500)??null,completed_at:completedAt,duration_ms:durationMs})});
  await fetch(`${input.url}/rest/v1/observability_spans`,{method:"POST",headers:{...auth,Prefer:"return=minimal"},body:JSON.stringify({job_run_id:input.jobId,trace_id:input.trace.traceId,span_id:input.trace.spanId,parent_span_id:input.trace.parentSpanId,name:"job:"+input.jobId,kind:"consumer",status:input.status==="failed"?"error":"ok",attributes:input.attributes??{},started_at:input.trace.startedAt,completed_at:completedAt,duration_ms:durationMs})});
}
