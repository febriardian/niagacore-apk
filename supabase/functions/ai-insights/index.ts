import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {classifyNiaQuestion,deterministicInsight,enrich,num,type Insight,type Kind,type Row} from "../_shared/decision-intelligence.ts";

const headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const CONTRACT_VERSION="nia-insights/v3";
const kinds:Kind[]=["overview","forecast","anomaly","finance","sales","customers","ask"];
const tasks:Record<Kind,string>={
  overview:"Jelaskan arti ringkasan terverifikasi dalam maksimal dua kalimat. Jangan memberi saran umum.",
  forecast:"Jelaskan arti prediksi terverifikasi dan batas penggunaannya dalam maksimal dua kalimat.",
  anomaly:"Jelaskan langkah pemeriksaan untuk sinyal yang benar-benar tercantum. Jangan membuat anomali baru.",
  finance:"Jelaskan arti ringkasan keuangan tanpa menghitung ulang atau menambahkan rekomendasi umum.",
  sales:"Jelaskan arti ringkasan penjualan tanpa menghitung ulang atau menambahkan target baru.",
  customers:"Jelaskan segmentasi RFM tanpa menyimpulkan atribut sensitif atau perilaku individu, maksimal dua kalimat.",
  ask:"Jawab pertanyaan secara langsung hanya dari potongan basis pengetahuan. Jangan membahas teknologi internal. Jika sumber tidak mendukung, nyatakan tidak ditemukan.",
};
const system=`Anda adalah lapisan penjelas NiagaCore. Mesin deterministik adalah satu-satunya sumber angka, sinyal, bukti, dan keputusan.
Dilarang menghitung ulang, membuat angka, confidence, anomali, aturan, sumber, atau fakta baru.
Untuk analisis, jelaskan arti hasil dalam maksimal dua kalimat. Rekomendasi harus kosong karena tindakan sudah ditentukan mesin deterministik.
Untuk Tanya NIA, jawab langsung dari knowledge dan sertakan citationIds. Jangan menyatakan hal yang tidak didukung sumber atau menjelaskan cara kerja internal.
Gunakan Bahasa Indonesia yang ringkas. Keluarkan JSON sesuai schema.`;
type ProviderOutput={explanation:string;recommendations:string[];citedEvidenceIds:string[];citations:string[]};
type Knowledge={citationId:string;title:string;content:string;score:number;chunkIndex:number};
type ProviderState="used"|"failed"|"configured"|"not_configured"|"not_attempted";
type Diagnostics={gemini:ProviderState;cloudflare:ProviderState;retrieval:"not_requested"|"no_source"|"ready"|"failed";embeddingProvider?:string;sourceCount:number;failures:string[]};

const schema={type:"object",additionalProperties:false,required:["explanation","recommendations","citedEvidenceIds","citations"],properties:{explanation:{type:"string",maxLength:900},recommendations:{type:"array",maxItems:4,items:{type:"string",maxLength:180}},citedEvidenceIds:{type:"array",maxItems:8,items:{type:"string",maxLength:80}},citations:{type:"array",maxItems:6,items:{type:"string",maxLength:40}}}};

function vector768(values:number[]){return values.slice(0,768).concat(Array(Math.max(0,768-values.length)).fill(0));}
function parseOutput(value:unknown,allowedEvidence:Set<string>,allowedCitations:Set<string>,allowedText:string,kind:Kind):ProviderOutput|null{
  const x=value as Partial<ProviderOutput>;
  if(!x||typeof x.explanation!=="string"||!Array.isArray(x.recommendations)||!Array.isArray(x.citedEvidenceIds)||!Array.isArray(x.citations))return null;
  const result={explanation:x.explanation.trim().slice(0,900),recommendations:x.recommendations.filter((item):item is string=>typeof item==="string").map(item=>item.trim().slice(0,180)).filter(Boolean).slice(0,4),citedEvidenceIds:x.citedEvidenceIds.filter((item):item is string=>typeof item==="string").slice(0,8),citations:x.citations.filter((item):item is string=>typeof item==="string").slice(0,6)};
  if(/\$\s*\{|dataset\s*\[|windowDays|revenueMinor|priceMinor|undefined|NaN/i.test(JSON.stringify(result)))return null;
  if(result.citedEvidenceIds.some(id=>!allowedEvidence.has(id))||result.citations.some(id=>!allowedCitations.has(id)))return null;
  if(kind==="ask"&&(!result.explanation||result.citations.length===0))return null;
  if(kind!=="ask"&&result.citedEvidenceIds.length===0)return null;
  const stripIds=(text:string)=>text.replace(/\b(?:K|[A-Z][A-Z_]+)\d*\b/g,""),numbers=(text:string)=>(stripIds(text).match(/\d+(?:[.,]\d+)*/g)??[]).map(token=>token.replace(/\D/g,"")).filter(Boolean);
  const allowedNumbers=new Set(numbers(allowedText));
  if(numbers(JSON.stringify(result)).some(token=>!allowedNumbers.has(token)))return null;
  return result;
}
function initialDiagnostics():Diagnostics{
  return{gemini:Deno.env.get("GEMINI_API_KEY")?"configured":"not_configured",cloudflare:Deno.env.get("CLOUDFLARE_ACCOUNT_ID")&&Deno.env.get("CLOUDFLARE_API_TOKEN")?"configured":"not_configured",retrieval:"not_requested",sourceCount:0,failures:[]};
}
async function sha256(value:string){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
async function rpc(url:string,anonKey:string,authorization:string,name:string,args:Row){
  const response=await fetch(`${url}/rest/v1/rpc/${name}`,{method:"POST",headers:{apikey:anonKey,Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify(args)});
  if(!response.ok)throw new Error(`${name}_failed`);
  return await response.json();
}
async function persistGovernance(url:string,serviceRoleKey:string,body:Row,dataset:Row,analytics:ReturnType<typeof enrich>,governance:Row,windowDays:number){
  const serialized=JSON.stringify(dataset),contentHash=await sha256(serialized),version=`${new Date().toISOString().slice(0,10)}-${contentHash.slice(0,12)}`;
  const datasetPayload={tenant_id:body.tenantId,business_id:body.businessId,branch_id:body.branchId,dataset_key:"nia_business_dataset",version,content_hash:contentHash,schema_version:"nia-business-dataset/v2",row_count:Array.isArray(dataset.salesByDay)?dataset.salesByDay.length:0,window_days:windowDays,metadata:{generatedAt:dataset.generatedAt??new Date().toISOString(),methods:analytics.methods}};
  const datasetResponse=await fetch(`${url}/rest/v1/nia_dataset_versions?on_conflict=tenant_id,business_id,branch_id,dataset_key,content_hash`,{method:"POST",headers:{apikey:serviceRoleKey,Authorization:`Bearer ${serviceRoleKey}`,"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=representation"},body:JSON.stringify(datasetPayload)});
  const datasetRows=datasetResponse.ok?await datasetResponse.json():[],datasetVersionId=datasetRows?.[0]?.id as string|undefined;
  const modelVersionId=((governance.models??{}) as Row).operational_anomaly&&typeof ((governance.models as Row).operational_anomaly as Row).versionId==="string"?String(((governance.models as Row).operational_anomaly as Row).versionId):null;
  if(analytics.drift.length){
    const driftRows=analytics.drift.map(metric=>({tenant_id:body.tenantId,business_id:body.businessId,branch_id:body.branchId,model_version_id:modelVersionId,dataset_version_id:datasetVersionId??null,metric_name:metric.name,metric_value:metric.value,threshold:metric.threshold,status:metric.status,baseline:{mean:metric.baseline},observed:{mean:metric.observed}}));
    await fetch(`${url}/rest/v1/nia_drift_measurements`,{method:"POST",headers:{apikey:serviceRoleKey,Authorization:`Bearer ${serviceRoleKey}`,"Content-Type":"application/json",Prefer:"return=minimal"},body:JSON.stringify(driftRows)});
  }
  return{datasetVersionId,datasetVersion:version,contentHash};
}
async function systemMatches(url:string,anonKey:string,authorization:string,question:string):Promise<Knowledge[]>{
  const response=await fetch(`${url}/rest/v1/rpc/match_nia_system_knowledge`,{method:"POST",headers:{apikey:anonKey,Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({query_text:question,match_count:5})});
  if(!response.ok)throw new Error("system_knowledge_retrieval_failed");
  const records=await response.json();
  return records.map((item:{id:string;title:string;content:string;score:number})=>({citationId:item.id,title:item.title,content:item.content.slice(0,1800),score:num(item.score),chunkIndex:0}));
}
async function cloudflare(task:string,input:unknown,allowedEvidence:Set<string>,allowedCitations:Set<string>,allowedText:string,kind:Kind){
  const account=Deno.env.get("CLOUDFLARE_ACCOUNT_ID"),token=Deno.env.get("CLOUDFLARE_API_TOKEN");if(!account||!token)throw new Error("not_configured");const model=Deno.env.get("CLOUDFLARE_AI_MODEL")??"@cf/meta/llama-3.1-8b-instruct";
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"system",content:system},{role:"user",content:JSON.stringify({task,input})}],temperature:.1,response_format:{type:"json_schema",json_schema:schema}})});
  const body=await response.json();if(!response.ok)throw new Error("request_failed");const raw=body?.result?.response,parsed=parseOutput(typeof raw==="string"?JSON.parse(raw):raw,allowedEvidence,allowedCitations,allowedText,kind);if(!parsed)throw new Error("ungrounded_output");return{output:parsed,provider:"cloudflare",model};
}
async function gemini(task:string,input:unknown,allowedEvidence:Set<string>,allowedCitations:Set<string>,allowedText:string,kind:Kind){
  const key=Deno.env.get("GEMINI_API_KEY");if(!key)throw new Error("not_configured");const model=Deno.env.get("GEMINI_MODEL")??"gemini-2.5-flash-lite";
  const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:"user",parts:[{text:JSON.stringify({task,input})}]}],generationConfig:{temperature:.1,maxOutputTokens:900,responseMimeType:"application/json",responseJsonSchema:schema}})});
  const body=await response.json();if(!response.ok)throw new Error("request_failed");const text=body?.candidates?.[0]?.content?.parts?.map((item:{text?:string})=>item.text??"").join(""),parsed=parseOutput(JSON.parse(text),allowedEvidence,allowedCitations,allowedText,kind);if(!parsed)throw new Error("ungrounded_output");return{output:parsed,provider:"gemini",model};
}
async function embedding(text:string){
  const key=Deno.env.get("GEMINI_API_KEY");
  if(key){const model=Deno.env.get("GEMINI_EMBEDDING_MODEL")??"gemini-embedding-001";const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(key)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:`models/${model}`,content:{parts:[{text}]},taskType:"RETRIEVAL_QUERY",outputDimensionality:768})});const body=await response.json();if(response.ok&&Array.isArray(body?.embedding?.values))return{values:vector768(body.embedding.values),provider:"gemini"};}
  const account=Deno.env.get("CLOUDFLARE_ACCOUNT_ID"),token=Deno.env.get("CLOUDFLARE_API_TOKEN");if(!account||!token)throw new Error("embedding_not_configured");const model=Deno.env.get("CLOUDFLARE_EMBEDDING_MODEL")??"@cf/baai/bge-base-en-v1.5";const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({text:[text]})});const body=await response.json(),values=body?.result?.data?.[0];if(!response.ok||!Array.isArray(values))throw new Error("embedding_failed");return{values:vector768(values),provider:"cloudflare"};
}
async function retrieve(url:string,anonKey:string,authorization:string,body:Row,question:string,diagnostics:Diagnostics):Promise<Knowledge[]>{
  let builtIn:Knowledge[]=[];
  try{builtIn=await systemMatches(url,anonKey,authorization,question);}catch(error){diagnostics.failures.push(error instanceof Error?error.message:"system_knowledge_retrieval_failed");}
  const complete=(remote:Knowledge[])=>{
    const combined=[...remote,...builtIn].filter((item,index,all)=>all.findIndex(other=>other.citationId===item.citationId)===index).sort((a,b)=>b.score-a.score).slice(0,8);
    diagnostics.retrieval=combined.length?"ready":"no_source";diagnostics.sourceCount=combined.length;return combined;
  };
  try{
    const embedded=await embedding(question);diagnostics.embeddingProvider=embedded.provider;
    const hybrid=await fetch(`${url}/rest/v1/rpc/match_nia_knowledge_hybrid`,{method:"POST",headers:{apikey:anonKey,Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({target_tenant_id:body.tenantId,target_business_id:body.businessId,target_branch_id:body.branchId,query_text:question,query_embedding:embedded.values,match_count:8})});
    if(hybrid.ok){
      const records=await hybrid.json(),knowledge=records.filter((item:{score?:number})=>num(item.score)>=.38).map((item:{title:string;content:string;score:number;chunk_index:number},index:number)=>({citationId:`K${index+1}`,title:item.title,content:item.content.slice(0,1800),score:num(item.score),chunkIndex:num(item.chunk_index)}));
      if(knowledge.length)return complete(knowledge);
    }
    const legacy=await fetch(`${url}/rest/v1/rpc/match_nia_knowledge`,{method:"POST",headers:{apikey:anonKey,Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({target_tenant_id:body.tenantId,target_business_id:body.businessId,target_branch_id:body.branchId,query_embedding:embedded.values,match_count:5})});
    if(!legacy.ok)throw new Error("retrieval_failed");
    const records=await legacy.json(),knowledge=records.filter((item:{similarity?:number})=>num(item.similarity)>=.48).map((item:{title:string;content:string;similarity:number},index:number)=>({citationId:`K${index+1}`,title:item.title,content:item.content.slice(0,1800),score:num(item.similarity),chunkIndex:0}));
    return complete(knowledge);
  }catch(error){console.warn("knowledge_retrieval_failed",error instanceof Error?error.message:"unknown");if(builtIn.length)return complete([]);diagnostics.retrieval="failed";return[];}
}
function mergeExplanation(base:Insight,kind:Kind,generated:ProviderOutput|null,knowledge:Knowledge[]){
  if(kind==="ask"&&generated){
    const cited=knowledge.filter(item=>generated.citations.includes(item.citationId));
    return{...base,title:"Jawaban dari basis pengetahuan",summary:generated.explanation,recommendations:generated.recommendations,evidence:cited.map(item=>`${item.citationId} • ${item.title}, bagian ${item.chunkIndex+1}`),evidenceIds:cited.map(item=>item.citationId),signalStrength:cited.some(item=>item.score>=.65)?"high":cited.length?"medium":"low"};
  }
  if(kind==="ask"&&knowledge.length){
    const primary=knowledge[0];
    return{...base,title:"Jawaban dari basis pengetahuan",summary:primary.content,recommendations:[],evidence:[`${primary.citationId} • ${primary.title}`],evidenceIds:[primary.citationId],signalStrength:primary.score>=.6?"high":"medium"};
  }
  if(generated)return{...base,explanation:generated.explanation};
  return base;
}
function providerOrder(kind:Kind){
  const enabled=(Deno.env.get("AI_PROVIDER_ORDER")??"cloudflare,gemini").split(",").map(item=>item.trim()).filter(item=>item==="cloudflare"||item==="gemini"),preferred=["forecast","finance","customers","ask"].includes(kind)?["gemini","cloudflare"]:["cloudflare","gemini"];
  return preferred.filter(provider=>enabled.includes(provider));
}
Deno.serve(async(request)=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers});if(request.method!=="POST")return Response.json({error:"method_not_allowed"},{status:405,headers});
  const authorization=request.headers.get("Authorization"),url=Deno.env.get("SUPABASE_URL"),anonKey=Deno.env.get("SUPABASE_ANON_KEY"),serviceRoleKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!authorization||!url||!anonKey)return Response.json({error:"authentication_required"},{status:401,headers});
  const body=await request.json().catch(()=>null) as (Row&{clientContractVersion?:string})|null;if(!body?.tenantId||!body?.businessId||!body?.branchId)return Response.json({error:"invalid_request"},{status:400,headers});
  const requestId=crypto.randomUUID();
  if(body.clientContractVersion&&body.clientContractVersion!==CONTRACT_VERSION)return Response.json({ok:false,contractVersion:CONTRACT_VERSION,requestId,error:{code:"contract_mismatch",message:"Versi aplikasi dan fungsi NIA belum cocok."}},{headers});
  const requestedKind:Kind=kinds.includes(body.kind as Kind)?body.kind as Kind:"overview",question=typeof body.question==="string"?body.question.trim().slice(0,500):"";if(requestedKind==="ask"&&question.length<4)return Response.json({error:"question_required"},{status:400,headers});
  const kind=requestedKind==="ask"?classifyNiaQuestion(question):requestedKind,order=providerOrder(kind),diagnostics=initialDiagnostics();
  const reservation=await fetch(`${url}/rest/v1/rpc/reserve_ai_request`,{method:"POST",headers:{apikey:anonKey,Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({target_tenant_id:body.tenantId,target_business_id:body.businessId,feature_name:kind,model_name:order.join(",")})});if(!reservation.ok||(await reservation.json())!==true)return Response.json({error:"ai_rate_limited",retryAfterSeconds:60},{status:429,headers:{...headers,"Retry-After":"60"}});
  const windowDays=Math.max(7,Math.min(365,num(body.windowDays)||90)),datasetResponse=await fetch(`${url}/rest/v1/rpc/get_ai_business_dataset`,{method:"POST",headers:{apikey:anonKey,Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({target_tenant_id:body.tenantId,target_branch_id:body.branchId,target_window_days:windowDays})});if(!datasetResponse.ok)return new Response(await datasetResponse.text(),{status:datasetResponse.status,headers});const rawDataset=await datasetResponse.json() as Row|null;if(!rawDataset)return Response.json({error:"branch_access_denied"},{status:403,headers});
  const [governanceValue,observationsValue]=await Promise.all([
    rpc(url,anonKey,authorization,"get_nia_runtime_governance",{target_tenant_id:body.tenantId,target_business_id:body.businessId}).catch(()=>({})),
    rpc(url,anonKey,authorization,"get_nia_anomaly_observations",{target_tenant_id:body.tenantId,target_business_id:body.businessId,target_branch_id:body.branchId,target_window_days:windowDays}).catch(()=>({})),
  ]),governance=(governanceValue??{}) as Row,dataset={...rawDataset,anomalyCalibration:governance.anomalyCalibration??{},anomalyObservations:observationsValue??{}};
  const analytics=enrich(dataset),base=deterministicInsight(kind,analytics,question),knowledge=kind==="ask"?await retrieve(url,anonKey,authorization,body,question,diagnostics):[];
  const allowedEvidence=new Set(base.evidenceIds),allowedCitations=new Set(knowledge.map(item=>item.citationId));
  if(kind==="ask")for(const item of allowedCitations)allowedEvidence.add(item);
  const providerInput=kind==="ask"?{question,knowledge}:{
    verifiedSummary:base.summary,verifiedEvidence:base.evidence.map((detail,index)=>({id:base.evidenceIds[index],detail})),dataQuality:base.dataQuality,signalStrength:base.signalStrength,
  };
  const allowedText=JSON.stringify(providerInput),shouldGenerate=kind==="ask"?knowledge.length>0:base.evidenceIds.length>0;
  let result:{output:ProviderOutput;provider:string;model:string}|null=null;
  if(shouldGenerate)for(const provider of order)try{
    if(provider==="cloudflare")result=await cloudflare(tasks[kind],providerInput,allowedEvidence,allowedCitations,allowedText,kind);
    if(provider==="gemini")result=await gemini(tasks[kind],providerInput,allowedEvidence,allowedCitations,allowedText,kind);
    if(result){diagnostics[provider as "gemini"|"cloudflare"]="used";break;}
  }catch(error){const code=error instanceof Error?error.message:"unknown";diagnostics[provider as "gemini"|"cloudflare"]="failed";diagnostics.failures.push(`${provider}:${code}`);console.warn("ai_provider_failed",provider,code);}
  const insight=mergeExplanation(base,kind,result?.output??null,knowledge),outputId=crypto.randomUUID(),generatedAt=new Date().toISOString(),source=result?"grounded_explanation":kind==="ask"&&knowledge.length?"grounded_retrieval":"deterministic";
  let governanceRecord:Row={};
  if(serviceRoleKey){try{governanceRecord=await persistGovernance(url,serviceRoleKey,body,dataset,analytics,governance,windowDays);}catch(error){console.warn("nia_governance_persistence_failed",error instanceof Error?error.message:"unknown");}const saved=await fetch(`${url}/rest/v1/ai_insights`,{method:"POST",headers:{apikey:serviceRoleKey,Authorization:`Bearer ${serviceRoleKey}`,"Content-Type":"application/json",Prefer:"return=minimal"},body:JSON.stringify({id:outputId,tenant_id:body.tenantId,branch_id:body.branchId,kind,title:insight.title,summary:insight.summary,severity:insight.signalStrength==="high"?"warning":"info",payload:{...insight,source,provider:result?.provider??"deterministic",model:result?.model??"niagacore-decision-intelligence-v3",generatedAt,analyticsMethods:analytics.methods,modelRegistry:governance.models??{},anomalyCalibration:governance.anomalyCalibration??{},drift:analytics.drift,...governanceRecord,retrievedDocuments:knowledge.map(item=>({citationId:item.citationId,title:item.title,chunkIndex:item.chunkIndex,score:item.score})),diagnostics}})});if(!saved.ok)console.warn("ai_output_persistence_failed",saved.status);}
  return Response.json({ok:true,contractVersion:CONTRACT_VERSION,requestId,analysisKind:kind,...insight,id:serviceRoleKey?outputId:undefined,source,provider:result?.provider??"deterministic",model:result?.model??"niagacore-decision-intelligence-v3",generatedAt,diagnostics,governance:{...governanceRecord,drift:analytics.drift},sources:knowledge.filter(item=>insight.evidenceIds.includes(item.citationId)).map(item=>({id:item.citationId,title:item.title,chunkIndex:item.chunkIndex,score:item.score})),analytics:{forecasts:analytics.forecasts.slice(0,8),anomalies:analytics.anomalies,customers:analytics.customers}},{headers});
});
