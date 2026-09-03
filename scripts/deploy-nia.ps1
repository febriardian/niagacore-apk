$ErrorActionPreference = "Stop"

Write-Host "Deploying NIA Edge Functions (contract nia-insights/v3)..." -ForegroundColor Cyan
npx supabase functions deploy ai-insights
if ($LASTEXITCODE -ne 0) { throw "Deploy ai-insights gagal." }

npx supabase functions deploy nia-knowledge
if ($LASTEXITCODE -ne 0) { throw "Deploy nia-knowledge gagal." }

npx supabase functions deploy nia-evaluator --no-verify-jwt
if ($LASTEXITCODE -ne 0) { throw "Deploy nia-evaluator gagal." }
npx supabase functions deploy health
if ($LASTEXITCODE -ne 0) { throw "Deploy health gagal." }

Write-Host "NIA v3, evaluator, dan health berhasil diterapkan. Pastikan workflow nia-operations memiliki SUPABASE_FUNCTIONS_URL dan NIA_EVALUATION_CRON_SECRET." -ForegroundColor Green
