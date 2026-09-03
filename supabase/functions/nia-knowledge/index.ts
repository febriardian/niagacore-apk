import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const allowedRoles=["owner","business_manager","branch_manager"];
type EmbeddingResult={values:number[];provider:"gemini"|"cloudflare"};

function vector768(values:number[]){
  return values.slice(0,768).concat(Array(Math.max(0,768-values.length)).fill(0));
}

async function embed(text:string):Promise<EmbeddingResult>{
  const key=Deno.env.get("GEMINI_API_KEY");
  if(key){
    const model=Deno.env.get("GEMINI_EMBEDDING_MODEL")??"gemini-embedding-001";
    const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(key)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:`models/${model}`,content:{parts:[{text}]},taskType:"RETRIEVAL_DOCUMENT",outputDimensionality:768})});
    const body=await response.json();
    if(response.ok&&Array.isArray(body?.embedding?.values))return{values:vector768(body.embedding.values),provider:"gemini"};
  }
  const account=Deno.env.get("CLOUDFLARE_ACCOUNT_ID"),token=Deno.env.get("CLOUDFLARE_API_TOKEN");
  if(!account||!token)throw new Error("embedding_not_configured");
  const model=Deno.env.get("CLOUDFLARE_EMBEDDING_MODEL")??"@cf/baai/bge-base-en-v1.5";
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({text:[text]})});
  const body=await response.json(),values=body?.result?.data?.[0];
  if(!response.ok||!Array.isArray(values))throw new Error("embedding_failed");
  return{values:vector768(values),provider:"cloudflare"};
}

function chunksOf(value:string){
  const text=value.replace(/\r\n/g,"\n").replace(/[ \t]+/g," ").trim();
  const chunks:string[]=[];
  let start=0;
  while(start<text.length&&chunks.length<24){
    let end=Math.min(text.length,start+1600);
    if(end<text.length){
      const newline=text.lastIndexOf("\n",end),space=text.lastIndexOf(" ",end);
      const boundary=Math.max(newline,space);
      if(boundary>start+800)end=boundary;
    }
    const chunk=text.slice(start,end).trim();
    if(chunk.length>=20)chunks.push(chunk);
    if(end>=text.length)break;
    start=Math.max(start+1,end-160);
  }
  return chunks;
}

async function sha256(value:string){
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map(item=>item.toString(16).padStart(2,"0")).join("");
}

Deno.serve(async(request)=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers});
  if(request.method!=="POST")return Response.json({error:"method_not_allowed"},{status:405,headers});
  const authorization=request.headers.get("Authorization"),url=Deno.env.get("SUPABASE_URL"),anonKey=Deno.env.get("SUPABASE_ANON_KEY"),serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!authorization||!url||!anonKey||!serviceKey)return Response.json({error:"authentication_required"},{status:401,headers});
  const userResponse=await fetch(`${url}/auth/v1/user`,{headers:{apikey:anonKey,Authorization:authorization}}),user=await userResponse.json();
  if(!userResponse.ok||!user?.id)return Response.json({error:"authentication_required"},{status:401,headers});
  const body=await request.json().catch(()=>null);
  if(!body?.tenantId||!body?.businessId||!body?.branchId)return Response.json({error:"invalid_request"},{status:400,headers});
  const access=await fetch(`${url}/rest/v1/rpc/get_ai_business_dataset`,{method:"POST",headers:{apikey:anonKey,Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({target_tenant_id:body.tenantId,target_branch_id:body.branchId,target_window_days:7})});
  const accessData=await access.json().catch(()=>null);
  if(!access.ok||accessData===null)return Response.json({error:"branch_access_denied"},{status:403,headers});
  const membershipResponse=await fetch(`${url}/rest/v1/memberships?tenant_id=eq.${body.tenantId}&user_id=eq.${user.id}&active=eq.true&select=role&limit=1`,{headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`}}),memberships=await membershipResponse.json(),role=memberships?.[0]?.role;
  if(!membershipResponse.ok||!allowedRoles.includes(role))return Response.json({error:"knowledge_management_denied"},{status:403,headers});
  const branchResponse=await fetch(`${url}/rest/v1/branches?tenant_id=eq.${body.tenantId}&id=eq.${body.branchId}&select=business_id&limit=1`,{headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`}}),branches=await branchResponse.json();
  if(!branchResponse.ok||branches?.[0]?.business_id!==body.businessId)return Response.json({error:"business_scope_mismatch"},{status:403,headers});
  const action=String(body.action??"list");
  const branchScope=role==="branch_manager"?`&or=(branch_id.is.null,branch_id.eq.${body.branchId})`:"";
  if(action==="list"){
    const response=await fetch(`${url}/rest/v1/nia_knowledge_documents?tenant_id=eq.${body.tenantId}&business_id=eq.${body.businessId}&active=eq.true${branchScope}&select=id,title,content,branch_id,metadata,updated_at&order=updated_at.desc`,{headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`}});
    if(!response.ok)return new Response(await response.text(),{status:response.status,headers});
    return Response.json({documents:await response.json()},{headers});
  }
  if(action==="delete"){
    if(!body.id)return Response.json({error:"document_id_required"},{status:400,headers});
    const deleteScope=role==="branch_manager"?`&branch_id=eq.${body.branchId}`:"";
    const response=await fetch(`${url}/rest/v1/nia_knowledge_documents?id=eq.${body.id}&tenant_id=eq.${body.tenantId}&business_id=eq.${body.businessId}${deleteScope}`,{method:"PATCH",headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,"Content-Type":"application/json"},body:JSON.stringify({active:false,updated_at:new Date().toISOString()})});
    if(!response.ok)return new Response(await response.text(),{status:response.status,headers});
    return Response.json({ok:true},{headers});
  }
  if(action!=="upsert")return Response.json({error:"invalid_action"},{status:400,headers});
  const title=String(body.title??"").trim().slice(0,160),content=String(body.content??"").trim().slice(0,12000);
  if(title.length<3||content.length<20)return Response.json({error:"knowledge_content_too_short"},{status:400,headers});
  try{
    const documentChunks=chunksOf(content);
    if(!documentChunks.length)throw new Error("knowledge_content_too_short");
    const fullEmbedding=await embed(`${title}\n${content}`),hash=await sha256(`${title}\n${content}`),now=new Date().toISOString();
    const appliesToAllBranches=body.allBranches===true&&["owner","business_manager"].includes(role),branchId=appliesToAllBranches?null:body.branchId;
    const response=await fetch(`${url}/rest/v1/nia_knowledge_documents?on_conflict=tenant_id,content_hash`,{method:"POST",headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=representation"},body:JSON.stringify({tenant_id:body.tenantId,business_id:body.businessId,branch_id:branchId,title,content,content_hash:hash,embedding:fullEmbedding.values,metadata:{source:"manual",language:"id",embeddingProvider:fullEmbedding.provider,chunkCount:documentChunks.length},active:true,created_by:user.id,updated_at:now})});
    if(!response.ok)return new Response(await response.text(),{status:response.status,headers});
    const document=(await response.json())?.[0];
    if(!document?.id)throw new Error("knowledge_document_write_failed");
    const chunkRows=[];
    for(let index=0;index<documentChunks.length;index++){
      const result=await embed(`${title}\nBagian ${index+1}\n${documentChunks[index]}`);
      chunkRows.push({document_id:document.id,tenant_id:body.tenantId,business_id:body.businessId,branch_id:branchId,chunk_index:index,content:documentChunks[index],embedding:result.values,metadata:{embeddingProvider:result.provider}});
    }
    const removed=await fetch(`${url}/rest/v1/nia_knowledge_chunks?document_id=eq.${document.id}`,{method:"DELETE",headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`}});
    if(!removed.ok)throw new Error("knowledge_chunk_reset_failed");
    const written=await fetch(`${url}/rest/v1/nia_knowledge_chunks`,{method:"POST",headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,"Content-Type":"application/json",Prefer:"return=minimal"},body:JSON.stringify(chunkRows)});
    if(!written.ok)throw new Error("knowledge_chunk_write_failed");
    return Response.json({document:{...document,chunkCount:chunkRows.length,embeddingProvider:fullEmbedding.provider}},{headers});
  }catch(error){
    console.warn("knowledge_index_failed",error instanceof Error?error.message:"unknown");
    return Response.json({error:"knowledge_index_failed"},{status:502,headers});
  }
});
