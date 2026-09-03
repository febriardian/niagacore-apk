#!/usr/bin/env node

const url=(process.env.SUPABASE_URL??"").replace(/\/$/,"");
const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY??"";
const confirmation=process.env.CONFIRM_RESET_ALL_ADMIN_MFA??"";

if(!url||!serviceKey){
  console.error("SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diisi.");
  process.exit(1);
}
if(confirmation!=="RESET_ALL_ADMIN_MFA"){
  console.error("Batalkan: set CONFIRM_RESET_ALL_ADMIN_MFA=RESET_ALL_ADMIN_MFA untuk menjalankan reset satu kali.");
  process.exit(1);
}

const headers={apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,"Content-Type":"application/json"};
const request=async(path,init={})=>{
  const response=await fetch(`${url}${path}`,{...init,headers:{...headers,...init.headers}});
  if(!response.ok)throw new Error(`${init.method??"GET"} ${path}: ${response.status} ${await response.text()}`);
  if(response.status===204)return null;
  const text=await response.text();
  return text?JSON.parse(text):null;
};

const admins=await request("/rest/v1/platform_admins?select=user_id,email&order=created_at.asc");
if(!Array.isArray(admins))throw new Error("Daftar admin tidak valid.");

let removed=0;
const failures=[];
for(const admin of admins){
  try{
    const factors=await request(`/auth/v1/admin/users/${encodeURIComponent(admin.user_id)}/factors`);
    const rows=Array.isArray(factors)?factors:(factors?.factors??[]);
    for(const factor of rows){
      await request(`/auth/v1/admin/users/${encodeURIComponent(admin.user_id)}/factors/${encodeURIComponent(factor.id)}`,{method:"DELETE"});
      removed+=1;
    }
    console.log(`${admin.email??admin.user_id}: ${rows.length} faktor dihapus`);
  }catch(error){
    failures.push(`${admin.email??admin.user_id}: ${error instanceof Error?error.message:String(error)}`);
  }
}

console.log(`Selesai. ${removed} faktor MFA dari ${admins.length} admin telah dihapus.`);
if(failures.length){
  console.error(`Reset belum lengkap untuk ${failures.length} admin:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Minta semua admin keluar lalu login kembali untuk mendaftarkan QR baru.");
