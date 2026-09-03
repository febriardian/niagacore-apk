import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const failures = [];
const rootPackage = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const mobilePackage = JSON.parse(await readFile(new URL("apps/mobile/package.json", root), "utf8"));
const appConfig = JSON.parse(await readFile(new URL("apps/mobile/app.json", root), "utf8"));
const eas = JSON.parse(await readFile(new URL("apps/mobile/eas.json", root), "utf8"));
const envExample = await readFile(new URL(".env.example", root), "utf8");
const migrationNames = (await readdir(new URL("supabase/migrations/", root))).filter((name) => name.endsWith(".sql")).sort();
const midtransFunctions = [
  "create-midtrans-transaction",
  "refund-midtrans",
  "reconcile-midtrans",
];

if (rootPackage.version !== mobilePackage.version || mobilePackage.version !== appConfig.expo.version) {
  failures.push("version_mismatch");
}
if (eas.build?.production?.environment !== "production") failures.push("production_environment_missing");
if (eas.build?.production?.env) failures.push("production_values_must_live_in_eas_environment");
if (!mobilePackage.dependencies?.["@react-native-ml-kit/text-recognition"]) failures.push("native_ocr_dependency_missing");
if (!mobilePackage.dependencies?.["@sentry/react-native"]) failures.push("monitoring_dependency_missing");
if (appConfig.expo.android?.package !== "id.niagacore.app") failures.push("android_package_identity_changed");
const androidVersionCode = appConfig.expo.android?.versionCode;
if (!Number.isInteger(androidVersionCode) || androidVersionCode < 1) failures.push("android_version_code_invalid");
if (migrationNames.at(-1) !== "202609030002_accounting_period_reporting_boundary.sql") failures.push("migration_head_unexpected");
if (!mobilePackage.dependencies?.["expo-notifications"]) failures.push("push_notification_dependency_missing");
const workspaceScopeMigration=await readFile(new URL("supabase/migrations/202608310001_workspace_branch_scope.sql",root),"utf8");
if(!workspaceScopeMigration.includes("create_business_branch(\n  target_business_id uuid")||!workspaceScopeMigration.includes("subledger_documents_select_branch"))failures.push("multi_business_branch_scope_missing");
const reliabilityMigration=await readFile(new URL("supabase/migrations/202608310003_release_reliability.sql",root),"utf8");
for(const contract of ["sync_failure_events","record_sync_review","resolve_sync_review","attach_qris_payment_session","get_recoverable_qris_payment","hardware_profiles"]){
  if(!reliabilityMigration.includes(contract))failures.push(`release_reliability_contract_missing:${contract}`);
}
const operationsMigration=await readFile(new URL("supabase/migrations/202608310004_operational_health_nia_qris.sql",root),"utf8");
for(const contract of ["qris_recovery_events","recover_qris_payment_session","get_operational_health"]){
  if(!operationsMigration.includes(contract))failures.push(`operational_contract_missing:${contract}`);
}
const remoteStore=await readFile(new URL("apps/mobile/src/lib/remote-store.ts",root),"utf8");
if(!remoteStore.includes('rpc("recover_qris_payment_session"')||!remoteStore.includes('from("sync_failure_events")')||!remoteStore.includes('from("sync_conflict_reviews")'))failures.push("truthful_sync_or_qris_recovery_missing");
const syncFunction=await readFile(new URL("supabase/functions/sync/index.ts",root),"utf8");
if(!syncFunction.includes("/rest/v1/rpc/record_sync_review"))failures.push("sync_review_persistence_missing");
for(const flow of ["pos-cash.yaml","credit-installment.yaml","shift.yaml","refund.yaml","branch-switch.yaml","device-revocation.yaml","report-scope.yaml","business-switch.yaml","cashier-role-boundary.yaml","qris-recovery.yaml","sync-truth.yaml","hardware-baseline.yaml","operational-health.yaml","nia-governance.yaml"]){
  try{await readFile(new URL(`.maestro/flows/${flow}`,root),"utf8")}catch{failures.push(`maestro_flow_missing:${flow}`)}
}
const criticalPath=await readFile(new URL(".maestro/critical-path.yaml",root),"utf8");
for(const flow of ["report-scope.yaml","business-switch.yaml","cashier-role-boundary.yaml","qris-recovery.yaml","sync-truth.yaml","hardware-baseline.yaml","operational-health.yaml","nia-governance.yaml"]){
  if(!criticalPath.includes(`flows/${flow}`))failures.push(`maestro_critical_path_missing:${flow}`);
}
for(const file of ["docs/INDEX.md","CARA_PASANG_2.12.0.md","PERUBAHAN_2.12.0.md","docs/runbooks/NIA_OPERATIONS.md","docs/runbooks/QRIS_RECOVERY.md","docs/runbooks/OBSERVABILITY.md","docs/runbooks/DATABASE_CONTRACTS.md",".github/workflows/nia-operations.yml","apps/mobile/src/screens/operational-health-screen.tsx","apps/mobile/src/screens/nia-governance-screen.tsx","config/database-contract.json","scripts/verify-database-contract.mjs"]){
  try{await readFile(new URL(file,root),"utf8")}catch{failures.push(`operational_file_missing:${file}`)}
}
const readme=await readFile(new URL("README.md",root),"utf8");
if(!readme.startsWith(`# NiagaCore ${rootPackage.version}`)||!readme.includes("202609030002_accounting_period_reporting_boundary.sql")||!readme.includes("docs/INDEX.md"))failures.push("documentation_version_or_head_inconsistent");
const observabilityMigration=await readFile(new URL("supabase/migrations/202608310005_governance_observability_contracts.sql",root),"utf8");
for(const contract of ["observability_job_runs","observability_spans","get_nia_governance_dashboard"]){
  if(!observabilityMigration.includes(contract))failures.push(`observability_contract_missing:${contract}`);
}
const databaseContract=JSON.parse(await readFile(new URL("config/database-contract.json",root),"utf8"));
if(databaseContract.contractVersion!==rootPackage.version||databaseContract.migrationHead!==migrationNames.at(-1))failures.push("database_contract_release_mismatch");
const healthFunction=await readFile(new URL("supabase/functions/health/index.ts",root),"utf8");
if(!healthFunction.includes("NIA_EVALUATION_CRON_SECRET")||!healthFunction.includes("MIDTRANS_ENVIRONMENT")||!healthFunction.includes("midtransAuthentication"))failures.push("operational_health_checks_incomplete");
const qrisFunction=await readFile(new URL("supabase/functions/create-midtrans-transaction/index.ts",root),"utf8");
if(!qrisFunction.includes('payment_type: "qris"')||!qrisFunction.includes('requestedPaymentType:"qris"')||!qrisFunction.includes('app.midtrans.com/snap/v1/transactions')||!qrisFunction.includes('enabled_payments:["gopay"]')||!qrisFunction.includes('attach_qris_payment_session_v2')||!qrisFunction.includes('fail_qris_payment_initialization_server')||!qrisFunction.includes('statusCode==="201"')||!qrisFunction.includes('qris_channel_not_activated'))failures.push("qris_dynamic_initialization_guard_missing");
const qrisIntegrity=await readFile(new URL("supabase/migrations/202609010001_qris_initialization_integrity.sql",root),"utf8");
if(!qrisIntegrity.includes("old.status='paid'")||qrisIntegrity.includes("or coalesce(old.status,'')='paid'"))failures.push("sale_status_enum_trigger_guard_missing");
const productionApp=await readFile(new URL("apps/mobile/src/screens/production-app.tsx",root),"utf8");
const operationsScreen=await readFile(new URL("apps/mobile/src/screens/operations-screen.tsx",root),"utf8");
if(productionApp.includes("RoleSimulatorScreen")||productionApp.includes("roleSimulator")||operationsScreen.includes("Simulator akses role"))failures.push("role_simulator_exposed_in_production");
const latestReporting = await readFile(new URL("supabase/migrations/202608150004_reporting_money_type_safety.sql", root), "utf8");
if (!latestReporting.includes("round(sum(i.quantity*i.cost_minor))") || latestReporting.includes("(result->>'costMinor')::bigint")) {
  failures.push("reporting_money_type_safety_missing");
}
const intelligenceMigration = await readFile(new URL("supabase/migrations/202608230002_intelligence_engine.sql", root), "utf8");
if (!intelligenceMigration.includes("OPERATOR(extensions.<=>)")) failures.push("vector_operator_schema_missing");
if (/::date\s+(?:as\s+)?day\b/i.test(intelligenceMigration) || /\bp\.days\b/.test(intelligenceMigration)) {
  failures.push("intelligence_reserved_alias_present");
}
if (!/demand\(product_id,sale_date,quantity\)[\s\S]*?group by i\.product_id,timezone\('Asia\/Jakarta',s\.occurred_at\)::date/.test(intelligenceMigration)) {
  failures.push("intelligence_demand_grouping_missing");
}
if (/group by\s+\d/i.test(intelligenceMigration)) failures.push("intelligence_ordinal_grouping_present");
if (!envExample.includes("EXPO_PUBLIC_UPDATE_MANIFEST_URL=")) failures.push("update_manifest_environment_missing");
for (const functionName of midtransFunctions) {
  const source = await readFile(new URL(`supabase/functions/${functionName}/index.ts`, root), "utf8");
  if (source.includes("api.sandbox.midtrans.com") || !/environment\s*!==\s*["']production["']/.test(source)) {
    failures.push(`midtrans_production_guard_missing:${functionName}`);
  }
}
try {
  const manifest = JSON.parse(await readFile(new URL("apps/distribution-web/releases/release.json", root), "utf8"));
  if (manifest.version !== rootPackage.version || manifest.versionCode !== appConfig.expo.android.versionCode) failures.push("distribution_manifest_version_mismatch");
  if (manifest.paymentModel !== "platform_wallet_manual_verified") failures.push("platform_wallet_payment_model_missing");
  if (manifest.channel === "production" && manifest.releaseStatus === "published") {
    if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) failures.push("published_release_checksum_invalid");
    if (!manifest.publishedAt) failures.push("published_release_date_missing");
    if (manifest.signatureVerified !== true) failures.push("published_release_signature_not_verified");
  }
} catch { failures.push("distribution_manifest_missing"); }

const forbiddenName = /(^|\/)(service-account|google-services\.json$)/i;
const forbiddenValue = /(sk-proj-[A-Za-z0-9_-]{20,}|Mid-server-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{60,}|BEGIN PRIVATE KEY)/i;
async function walk(path, relative = "") {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const childRelative = join(relative, entry.name).replaceAll("\\", "/");
    if (["node_modules", ".git", ".turbo", ".expo", "dist"].includes(entry.name)) continue;
    if (forbiddenName.test(childRelative) || (entry.name.startsWith(".env") && entry.name !== ".env.example")) failures.push(`forbidden_file:${childRelative}`);
    if (entry.isDirectory()) await walk(join(path, entry.name), childRelative);
    else if (entry.name !== "pnpm-lock.yaml" && /\.(ts|tsx|js|mjs|json|ya?ml)$/i.test(entry.name)) {
      const body = await readFile(join(path, entry.name), "utf8");
      if (childRelative !== "scripts/release-audit.mjs" && forbiddenValue.test(body)) failures.push(`possible_secret:${childRelative}`);
    }
  }
}
await walk(rootPath);
if (failures.length) {
  console.error(`Release audit failed:\n- ${[...new Set(failures)].join("\n- ")}`);
  process.exit(1);
}
console.log(`Release audit passed for NiagaCore ${rootPackage.version}.`);
