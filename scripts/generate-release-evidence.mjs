import {createHash} from "node:crypto";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {basename} from "node:path";

const root=new URL("../",import.meta.url),releaseDir=new URL("../apps/distribution-web/releases/",import.meta.url);
const rootPackage=JSON.parse(await readFile(new URL("package.json",root),"utf8"));
const mobilePackage=JSON.parse(await readFile(new URL("apps/mobile/package.json",root),"utf8"));
const lock=await readFile(new URL("pnpm-lock.yaml",root),"utf8");
const migrations=(await readdir(new URL("supabase/migrations/",root))).filter((name)=>name.endsWith(".sql")).sort();
const componentEntries=Object.entries({...mobilePackage.dependencies,...rootPackage.devDependencies}).sort(([a],[b])=>a.localeCompare(b));
const generatedAt=new Date().toISOString();
const sbom={bomFormat:"CycloneDX",specVersion:"1.5",version:1,metadata:{timestamp:generatedAt,component:{type:"application",name:"NiagaCore",version:rootPackage.version}},components:componentEntries.map(([name,version])=>({type:"library",name,version:String(version) }))};
const provenance={schemaVersion:1,application:"NiagaCore",version:rootPackage.version,generatedAt,androidPackage:"id.niagacore.app",lockfileSha256:createHash("sha256").update(lock).digest("hex"),migrationHead:basename(migrations.at(-1)??""),migrationCount:migrations.length,sourceChecks:["lint","typescript","unit-test","migration-audit","secret-audit","android-export"]};
await mkdir(releaseDir,{recursive:true});
await writeFile(new URL("sbom.json",releaseDir),JSON.stringify(sbom,null,2)+"\n");
await writeFile(new URL("provenance.json",releaseDir),JSON.stringify(provenance,null,2)+"\n");
console.log(`Release evidence generated for NiagaCore ${rootPackage.version}.`);
