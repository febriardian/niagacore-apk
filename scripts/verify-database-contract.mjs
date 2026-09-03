import {createHash} from "node:crypto";
import {readFile,readdir,access} from "node:fs/promises";

const root=new URL("../",import.meta.url),contract=JSON.parse(await readFile(new URL("config/database-contract.json",root),"utf8"));
const migrations=(await readdir(new URL("supabase/migrations/",root))).filter(name=>name.endsWith(".sql")).sort();
const sql=(await Promise.all(migrations.map(name=>readFile(new URL(`supabase/migrations/${name}`,root),"utf8")))).join("\n");
const failures=[];
if(contract.migrationHead!==migrations.at(-1))failures.push(`migration_head:${migrations.at(-1)}`);
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
for(const [table,columns] of Object.entries(contract.tables)){
  const match=sql.match(new RegExp(`create\\s+table(?:\\s+if\\s+not\\s+exists)?\\s+public\\.${escape(table)}\\s*\\(([\\s\\S]*?)\\n\\);`,"i"));
  if(!match){failures.push(`table_missing:${table}`);continue;}
  for(const column of columns)if(!new RegExp(`(^|[,\\n])\\s*${escape(column)}\\s+`,"i").test(match[1]))failures.push(`column_missing:${table}.${column}`);
}
for(const name of contract.functions)if(!new RegExp(`function\\s+public\\.${escape(name)}\\s*\\(`,"i").test(sql))failures.push(`function_missing:${name}`);
let mobile="";async function walk(url){for(const entry of await readdir(url,{withFileTypes:true})){const child=new URL(entry.name+(entry.isDirectory()?"/":""),url);if(entry.isDirectory())await walk(child);else if(/\.(ts|tsx)$/.test(entry.name))mobile+=await readFile(child,"utf8")}}await walk(new URL("apps/mobile/src/",root));
for(const name of contract.mobileRpc)if(!mobile.includes(`rpc("${name}"`)&&!mobile.includes(`rpc('${name}'`))failures.push(`mobile_rpc_missing:${name}`);
for(const name of contract.edgeFunctions){try{await access(new URL(`supabase/functions/${name}/index.ts`,root))}catch{failures.push(`edge_function_missing:${name}`)}}
for(const name of contract.tracedEdgeFunctions){const source=await readFile(new URL(`supabase/functions/${name}/index.ts`,root),"utf8");if(!source.includes("createTraceContext")||!source.includes("traceId"))failures.push(`distributed_trace_missing:${name}`)}
if(contract.contractVersion!==(JSON.parse(await readFile(new URL("package.json",root),"utf8"))).version)failures.push("contract_version_mismatch");
if(failures.length){console.error(`Database contract failed:\n- ${failures.join("\n- ")}`);process.exit(1)}
const digest=createHash("sha256").update(JSON.stringify(contract)).digest("hex");
console.log(`Database contract ${contract.contractVersion} passed (${Object.keys(contract.tables).length} tables, ${contract.functions.length} RPCs, sha256:${digest.slice(0,16)}).`);
