$ErrorActionPreference = "Stop"

function Read-SecretText([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$accountId = (Read-Host "Cloudflare Account ID").Trim()
$cloudflareToken = Read-SecretText "Cloudflare Workers AI API Token"
$geminiKey = Read-SecretText "Google Gemini API Key"
$evaluationSecret = Read-SecretText "NIA evaluation cron secret (minimal 24 karakter)"
if (!$accountId -or !$cloudflareToken -or !$geminiKey -or $evaluationSecret.Length -lt 24) { throw "Kredensial AI dan cron secret wajib diisi." }
if (($accountId + $cloudflareToken + $geminiKey + $evaluationSecret) -match "[`r`n]") { throw "Kredensial tidak valid." }

$temporaryFile = [IO.Path]::GetTempFileName()
try {
  @(
    "AI_PROVIDER_ORDER=cloudflare,gemini"
    "CLOUDFLARE_ACCOUNT_ID=$accountId"
    "CLOUDFLARE_API_TOKEN=$cloudflareToken"
    "CLOUDFLARE_AI_MODEL=@cf/meta/llama-3.1-8b-instruct"
    "CLOUDFLARE_EMBEDDING_MODEL=@cf/baai/bge-base-en-v1.5"
    "GEMINI_API_KEY=$geminiKey"
    "GEMINI_MODEL=gemini-2.5-flash-lite"
    "GEMINI_EMBEDDING_MODEL=gemini-embedding-001"
    "NIA_EVALUATION_CRON_SECRET=$evaluationSecret"
  ) | Set-Content -Path $temporaryFile -Encoding utf8
  npx supabase secrets set --env-file $temporaryFile
  if ($LASTEXITCODE -ne 0) { throw "Gagal menyimpan Supabase secrets." }
  npx supabase functions deploy ai-insights
  if ($LASTEXITCODE -ne 0) { throw "Gagal menerapkan Edge Function ai-insights." }
  npx supabase functions deploy nia-knowledge
  if ($LASTEXITCODE -ne 0) { throw "Gagal menerapkan Edge Function nia-knowledge." }
  npx supabase functions deploy nia-evaluator --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { throw "Gagal menerapkan Edge Function nia-evaluator." }
  npx supabase functions deploy health
  if ($LASTEXITCODE -ne 0) { throw "Gagal menerapkan Edge Function health." }
  Write-Host "Cloudflare, Gemini, basis pengetahuan, evaluator NIA, dan health berhasil dikonfigurasi." -ForegroundColor Green
}
finally {
  if (Test-Path $temporaryFile) { Remove-Item $temporaryFile -Force }
  $cloudflareToken = $null
  $geminiKey = $null
  $evaluationSecret = $null
}
