param([string]$ProjectRef="")
$ErrorActionPreference="Stop"
$root=Split-Path -Parent $PSScriptRoot
Set-Location $root

if(-not $ProjectRef -and (Test-Path "supabase/.temp/project-ref")){$ProjectRef=(Get-Content "supabase/.temp/project-ref" -Raw).Trim()}
if(-not $ProjectRef -and $env:SUPABASE_PROJECT_REF){$ProjectRef=$env:SUPABASE_PROJECT_REF.Trim()}
if(-not $ProjectRef){
  foreach($candidate in @(".env.local",".env")){
    if(Test-Path $candidate){
      $line=Get-Content $candidate|Where-Object{$_ -match '^EXPO_PUBLIC_SUPABASE_URL=https://([a-z0-9]+)\.supabase\.co'}|Select-Object -First 1
      if($line -and $line -match 'https://([a-z0-9]+)\.supabase\.co'){$ProjectRef=$Matches[1];break}
    }
  }
}
if(-not $ProjectRef){throw "Project Ref Supabase tidak ditemukan. Jalankan ulang dengan -ProjectRef PROJECT_REF."}

Write-Host "Menerapkan migrasi QRIS dan NIA..." -ForegroundColor Cyan
npx supabase link --project-ref $ProjectRef
if($LASTEXITCODE-ne 0){throw "Supabase project gagal ditautkan."}
npx supabase db push
if($LASTEXITCODE-ne 0){throw "Migrasi QRIS gagal."}

Write-Host "Deploy fungsi pembayaran dan status..." -ForegroundColor Cyan
npx supabase functions deploy create-midtrans-transaction --project-ref $ProjectRef
if($LASTEXITCODE-ne 0){throw "Deploy create-midtrans-transaction gagal."}
npx supabase functions deploy health --project-ref $ProjectRef
if($LASTEXITCODE-ne 0){throw "Deploy health gagal."}
npx supabase functions deploy nia-evaluator --no-verify-jwt --project-ref $ProjectRef
if($LASTEXITCODE-ne 0){throw "Deploy nia-evaluator gagal."}

foreach($obsolete in @("apps/mobile/src/screens/role-simulator-screen.tsx",".maestro/flows/role-simulator.yaml")){
  if(Test-Path $obsolete){Remove-Item $obsolete -Force}
}

Write-Host "Selesai. Tutup Expo Go, jalankan 'npx expo start --clear', lalu buka kembali aplikasi. Evaluasi NIA terbaru dibuat pada jadwal workflow berikutnya atau saat workflow dijalankan manual." -ForegroundColor Green
