import{createHash}from"node:crypto";
import{mkdtemp,readFile,rm,writeFile,mkdir}from"node:fs/promises";
import{tmpdir}from"node:os";
import{dirname,join,resolve}from"node:path";
import{spawn}from"node:child_process";
const source=process.env.BACKUP_DATABASE_URL,restore=process.env.RESTORE_DATABASE_URL;
if(!source||!restore)throw new Error("BACKUP_DATABASE_URL and RESTORE_DATABASE_URL are required");
if(source===restore)throw new Error("restore_target_must_not_equal_source");
if(process.env.CONFIRM_ISOLATED_RESTORE!=="YES")throw new Error("Set CONFIRM_ISOLATED_RESTORE=YES after verifying the restore target is isolated staging");
const run=(command,args,capture=false)=>new Promise((resolveRun,reject)=>{let output="";const child=spawn(command,args,{stdio:capture?["ignore","pipe","inherit"]:"inherit",env:process.env});if(capture)child.stdout.on("data",chunk=>output+=chunk);child.on("error",reject);child.on("exit",code=>code===0?resolveRun(output.trim()):reject(new Error(`${command} exited ${code}`)))});
const directory=await mkdtemp(join(tmpdir(),"niagacore-restore-")),archive=join(directory,"backup.dump"),startedAt=new Date().toISOString();
try{
  await run("pg_dump",["--format=custom","--no-owner","--no-acl","--file",archive,source]);
  await run("pg_restore",["--clean","--if-exists","--no-owner","--no-acl","--dbname",restore,archive]);
  const metrics=await run("psql",[restore,"--set","ON_ERROR_STOP=1","--tuples-only","--no-align","--field-separator",",","--command",`select (select count(*) from public.tenants),(select count(*) from public.businesses),(select count(*) from public.branches),(select count(*) from public.sales),(select count(*) from public.audit_events),(select count(*) from public.journal_entries e where exists(select 1 from public.journal_lines l where l.entry_id=e.id group by l.entry_id having sum(l.debit_minor)<>sum(l.credit_minor)));`],true);
  const [tenants,businesses,branches,sales,auditEvents,imbalancedJournals]=metrics.split(",").map(Number);
  if([tenants,businesses,branches,sales,auditEvents,imbalancedJournals].some(Number.isNaN)||imbalancedJournals!==0)throw new Error("restore_integrity_check_failed");
  const dumpSha256=createHash("sha256").update(await readFile(archive)).digest("hex"),evidencePath=resolve(process.env.BACKUP_DRILL_EVIDENCE||"release-evidence/backup-restore-drill.json");
  await mkdir(dirname(evidencePath),{recursive:true});
  await writeFile(evidencePath,JSON.stringify({status:"passed",startedAt,completedAt:new Date().toISOString(),dumpSha256,counts:{tenants,businesses,branches,sales,auditEvents},imbalancedJournals},null,2)+"\n");
  console.log(`Backup and isolated restore drill passed. Evidence: ${evidencePath}`);
}finally{await rm(directory,{recursive:true,force:true});}
