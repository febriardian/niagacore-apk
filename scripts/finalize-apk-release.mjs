import{createHash}from'node:crypto';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{readFile,writeFile,copyFile,stat}from'node:fs/promises';
import{basename,resolve}from'node:path';
const exec=promisify(execFile),apk=process.argv[2];
if(!apk)throw new Error('Usage: pnpm release:apk <signed-apk-path> [published-at-ISO]');
const source=resolve(apk),info=await stat(source);
if(!info.isFile()||info.size<1_000_000)throw new Error('APK tidak valid atau terlalu kecil');
const apksigner=process.env.APKSIGNER_PATH||'apksigner',apkanalyzer=process.env.APKANALYZER_PATH||'apkanalyzer';
await exec(apksigner,['verify','--verbose','--print-certs',source]);
const [{stdout:versionName},{stdout:versionCode}]=await Promise.all([
  exec(apkanalyzer,['manifest','version-name',source]),exec(apkanalyzer,['manifest','version-code',source])
]);
const manifestUrl=new URL('../apps/distribution-web/releases/release.json',import.meta.url);
const manifest=JSON.parse(await readFile(manifestUrl,'utf8'));
if(versionName.trim()!==manifest.version||Number(versionCode.trim())!==manifest.versionCode)throw new Error(`APK version ${versionName.trim()} (${versionCode.trim()}) tidak cocok dengan manifest ${manifest.version} (${manifest.versionCode})`);
const bytes=await readFile(source),sha256=createHash('sha256').update(bytes).digest('hex');
const target=new URL('../apps/distribution-web/releases/niagacore-latest.apk',import.meta.url);
await copyFile(source,target);
manifest.sha256=sha256;manifest.publishedAt=process.argv[3]??new Date().toISOString();
if(Number.isNaN(Date.parse(manifest.publishedAt)))throw new Error('published-at must be ISO date');
manifest.sourceFile=basename(source);manifest.sizeBytes=info.size;manifest.signatureVerified=true;manifest.releaseStatus='published';
await writeFile(manifestUrl,JSON.stringify(manifest,null,2)+'\n');
console.log(`Signed APK verified and finalized. SHA-256: ${sha256}`);
