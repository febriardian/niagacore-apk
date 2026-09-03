import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {createTraceContext,finishObservedJob,startObservedJob,traceHeaders} from "../_shared/observability.ts";

const jsonHeaders={"Content-Type":"application/json"};
type Outbox={id:string;recipient_user_id:string;title:string;body:string;data:Record<string,unknown>;attempts:number};
type PushToken={id:string;user_id:string;token:string};

Deno.serve(async(request)=>{
  const trace=createTraceContext(request),responseHeaders={...jsonHeaders,...traceHeaders(trace)};
  if(request.method!=="POST")return Response.json({error:"method_not_allowed",traceId:trace.traceId},{status:405,headers:responseHeaders});
  const expected=Deno.env.get("NOTIFICATION_CRON_SECRET");
  if(!expected||request.headers.get("x-cron-secret")!==expected)return Response.json({error:"unauthorized",traceId:trace.traceId},{status:401,headers:responseHeaders});
  const url=Deno.env.get("SUPABASE_URL"),serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!serviceKey)return Response.json({error:"service_not_configured",traceId:trace.traceId},{status:503,headers:responseHeaders});
  const jobId=await startObservedJob({url,serviceKey,trace,jobName:"notification.dispatch",triggerSource:"cron"});
  const db=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  await db.rpc("enqueue_operational_notifications");
  const {data:rows,error}=await db.from("notification_outbox").select("id,recipient_user_id,title,body,data,attempts").in("status",["pending","failed"]).lt("attempts",5).order("created_at").limit(100);
  if(error){await finishObservedJob({url,serviceKey,trace,jobId,status:"failed",error});return Response.json({error:"outbox_read_failed",detail:error.message,traceId:trace.traceId},{status:500,headers:responseHeaders});}
  const outbox=(rows??[]) as Outbox[];
  if(!outbox.length){await finishObservedJob({url,serviceKey,trace,jobId,status:"succeeded",counts:{processed:0,succeeded:0,failed:0}});return Response.json({processed:0,sent:0,failed:0,traceId:trace.traceId},{headers:responseHeaders});}
  await db.from("notification_outbox").update({status:"processing"}).in("id",outbox.map(row=>row.id));
  const users=[...new Set(outbox.map(row=>row.recipient_user_id))];
  const {data:tokenRows,error:tokenError}=await db.from("push_tokens").select("id,user_id,token").in("user_id",users).eq("enabled",true);
  if(tokenError){await finishObservedJob({url,serviceKey,trace,jobId,status:"failed",counts:{processed:outbox.length},error:tokenError});return Response.json({error:"token_read_failed",detail:tokenError.message,traceId:trace.traceId},{status:500,headers:responseHeaders});}
  const tokens=(tokenRows??[]) as PushToken[];
  const messages=outbox.flatMap(row=>tokens.filter(token=>token.user_id===row.recipient_user_id).map(token=>({
    to:token.token,sound:"default",title:row.title,body:row.body,data:{...row.data,notificationId:row.id},priority:"high",channelId:"operasional",
    outboxId:row.id,tokenId:token.id,
  })));
  const resultByOutbox=new Map<string,{sent:boolean;errors:string[]}>();
  for(const row of outbox)resultByOutbox.set(row.id,{sent:false,errors:[]});
  for(let offset=0;offset<messages.length;offset+=100){
    const batch=messages.slice(offset,offset+100);
    const response=await fetch("https://exp.host/--/api/v2/push/send",{method:"POST",headers:{...jsonHeaders,...traceHeaders(trace)},body:JSON.stringify(batch.map(({outboxId:_,tokenId:__,...message})=>message))}).catch(()=>null);
    const payload=response?await response.json().catch(()=>({data:[]})) as {data?:{status?:string;message?:string;details?:{error?:string}}[]}:{data:[]};
    batch.forEach((message,index)=>{
      const receipt=payload.data?.[index],state=resultByOutbox.get(message.outboxId)!;
      if(response?.ok&&receipt?.status==="ok")state.sent=true;
      else{
        state.errors.push(receipt?.message??(response?`expo_http_${response.status}`:"expo_network_error"));
        if(receipt?.details?.error==="DeviceNotRegistered")void db.from("push_tokens").update({enabled:false}).eq("id",message.tokenId);
      }
    });
  }
  let sent=0,failed=0;
  for(const row of outbox){
    const state=resultByOutbox.get(row.id)!;
    const noToken=!tokens.some(token=>token.user_id===row.recipient_user_id);
    const next=state.sent
      ?{status:"sent",sent_at:new Date().toISOString(),attempts:row.attempts+1,last_error:null}
      :noToken
        ?{status:"pending",attempts:row.attempts,last_error:"push_token_missing"}
        :{status:"failed",attempts:row.attempts+1,last_error:state.errors.join("; ").slice(0,500)};
    const update=await db.from("notification_outbox").update(next).eq("id",row.id);
    if(update.error)failed++;else if(state.sent)sent++;else failed++;
  }
  await finishObservedJob({url,serviceKey,trace,jobId,status:failed?sent?"partial":"failed":"succeeded",counts:{processed:outbox.length,succeeded:sent,failed},attributes:{messageCount:messages.length}});
  return Response.json({processed:outbox.length,sent,failed,traceId:trace.traceId},{headers:responseHeaders});
});
