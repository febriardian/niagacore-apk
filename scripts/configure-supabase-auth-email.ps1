param(
  [string]$ProjectRef = "",
  [string]$SmtpHost = "",
  [int]$SmtpPort = 587,
  [string]$SmtpUser = "",
  [string]$SenderEmail = "",
  [string]$SenderName = "NiagaCore"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function ConvertFrom-SecureValue([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Read-ProjectRef {
  foreach ($candidate in @((Join-Path $root ".env"),(Join-Path $root "apps/mobile/.env"),(Join-Path $root ".env.local"))) {
    if (-not (Test-Path $candidate)) { continue }
    $line = Get-Content $candidate | Where-Object { $_ -match '^EXPO_PUBLIC_SUPABASE_URL=' } | Select-Object -First 1
    if ($line -and $line -match 'https://([a-z0-9]+)\.supabase\.co') { return $Matches[1] }
  }
  return ""
}

function Get-HttpErrorDetail($ErrorRecord) {
  if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
    return [string]$ErrorRecord.ErrorDetails.Message
  }
  try {
    $response = $ErrorRecord.Exception.Response
    if ($response -and $response.GetResponseStream()) {
      $reader = [IO.StreamReader]::new($response.GetResponseStream())
      try { return $reader.ReadToEnd() }
      finally { $reader.Dispose() }
    }
  } catch { }
  return [string]$ErrorRecord.Exception.Message
}

function Assert-AuthConfigWrite {
  $uri = "https://api.supabase.com/v1/projects/$ProjectRef/config/auth"
  try {
    $current = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 60
    # PATCH nilai yang sama: menguji auth_config_write tanpa mengubah konfigurasi.
    $probe = @{ external_email_enabled = [bool]$current.external_email_enabled } | ConvertTo-Json
    Invoke-RestMethod -Method Patch -Uri $uri -Headers $headers -Body $probe -TimeoutSec 90 | Out-Null
    return $current
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    $detail = Get-HttpErrorDetail $_
    if ($status -eq 403) {
      throw "Akses Auth Config ditolak (403). Token harus memiliki Auth Config = Read-write (auth_config_write), dibatasi ke project $ProjectRef, dan akun pembuat token harus berperan Owner atau Administrator di organisasi/project Supabase. Role 'Pemilik' di aplikasi NiagaCore tidak sama dengan role Supabase. Detail server: $detail"
    }
    if ($status -eq 401) {
      throw "Token ditolak (401). Salin token scoped yang masih aktif dan lengkap. Detail server: $detail"
    }
    throw "Pemeriksaan Auth Config gagal. Detail server: $detail"
  }
}

function Test-ExpectedConfig($Current, [hashtable]$Expected) {
  foreach ($key in $Expected.Keys) {
    if ([string]$Current.$key -ne [string]$Expected[$key]) { return $false }
  }
  return $true
}

function Set-AuthConfig([hashtable]$Values, [hashtable]$Expected, [string]$Label) {
  $uri = "https://api.supabase.com/v1/projects/$ProjectRef/config/auth"
  $body = $Values | ConvertTo-Json -Depth 6
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      Invoke-RestMethod -Method Patch -Uri $uri -Headers $headers -Body $body -TimeoutSec 240 | Out-Null
      return
    } catch {
      if ($_.Exception.Message -notmatch 'timed out|timeout') { throw }
      Write-Host "$Label belum memberi respons. Memeriksa hasil langsung dari server..." -ForegroundColor Yellow
      Start-Sleep -Seconds 5
      try {
        $current = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 60
        if (Test-ExpectedConfig $current $Expected) {
          Write-Host "$Label ternyata sudah tersimpan." -ForegroundColor Green
          return
        }
      } catch { if ($attempt -eq 2) { throw } }
      if ($attempt -eq 1) { Write-Host "Mencoba $Label satu kali lagi..." -ForegroundColor Yellow }
    }
  }
  throw "$Label belum tersimpan setelah dua percobaan. Coba lagi beberapa menit kemudian."
}

try {
  Write-Host "=== Konfigurasi email produksi NiagaCore ===" -ForegroundColor Cyan
  Write-Host "Tidak perlu supabase login. Token dan password tidak disimpan ke file." -ForegroundColor DarkGray

  if (-not $ProjectRef) { $ProjectRef = Read-ProjectRef }
  if (-not $ProjectRef) { $ProjectRef = Read-Host "Project Ref Supabase (bagian sebelum .supabase.co)" }
  if (-not $ProjectRef) { throw "Project Ref wajib diisi." }

  Write-Host "Salin Personal Access Token lengkap yang diawali sbp_ ke clipboard." -ForegroundColor Yellow
  Read-Host "Setelah disalin, kembali ke terminal dan tekan Enter (jangan paste token di sini)" | Out-Null
  try { $accessToken = [string](Get-Clipboard -Raw -ErrorAction Stop) }
  catch { throw "Clipboard tidak dapat dibaca. Salin token lalu jalankan script kembali." }
  $accessToken = $accessToken -replace '[\x00-\x20\x7F]', ''
  if ($accessToken -notmatch '^sbp_[A-Za-z0-9_-]{20,}$') {
    throw "Clipboard tidak berisi Personal Access Token Supabase yang valid. Buka halaman Access Tokens, salin token lengkap, lalu coba lagi."
  }
  $env:SUPABASE_ACCESS_TOKEN = $accessToken
  $headers = @{ Authorization = "Bearer $accessToken"; "Content-Type" = "application/json" }

  Write-Host "[1/5] Memeriksa akun, project, dan izin Auth Config..."
  try {
    Invoke-RestMethod -Method Get -Uri "https://api.supabase.com/v1/projects/$ProjectRef" -Headers $headers -TimeoutSec 45 | Out-Null
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 401 -or $status -eq 403) {
      throw "Token ini tidak memiliki hak Owner/Administrator pada project $ProjectRef. Buat token dari akun yang membuat project tersebut."
    }
    throw
  }

  # Pastikan izin tulis benar sebelum meminta host, user, dan password SMTP.
  $currentAuthConfig = Assert-AuthConfigWrite
  Write-Host "Izin Auth Config Read-write terverifikasi." -ForegroundColor Green

  if (-not $SmtpHost) { $SmtpHost = Read-Host "Host SMTP Rumahweb" }
  if (-not $SmtpUser) { $SmtpUser = Read-Host "Username/email SMTP Rumahweb" }
  if (-not $SenderEmail) { $SenderEmail = $SmtpUser }
  if (-not $SmtpHost -or -not $SmtpUser -or -not $SenderEmail) { throw "Host, username, dan email pengirim SMTP wajib diisi." }
  $smtpPasswordSecure = Read-Host "Password mailbox SMTP Rumahweb" -AsSecureString
  $smtpPassword = ConvertFrom-SecureValue $smtpPasswordSecure
  if (-not $smtpPassword) { throw "Password SMTP kosong." }

  Write-Host "[2/5] Memeriksa koneksi ke server SMTP..."
  $tcp = [Net.Sockets.TcpClient]::new()
  try {
    $connection = $tcp.ConnectAsync($SmtpHost,$SmtpPort)
    if (-not $connection.Wait(15000) -or -not $tcp.Connected) { throw "timeout" }
  } catch { throw "Host SMTP $SmtpHost`:$SmtpPort tidak dapat dijangkau. Periksa host dan port pada panel Rumahweb." }
  finally { $tcp.Dispose() }

  Write-Host "[3/5] Menerapkan konfigurasi email..."
  $authConfigUri = "https://api.supabase.com/v1/projects/$ProjectRef/config/auth"
  # Ambil ulang agar allow-list yang dipertahankan selalu versi terbaru.
  $currentAuthConfig = Invoke-RestMethod -Method Get -Uri $authConfigUri -Headers $headers -TimeoutSec 60
  $redirects = @([string]$currentAuthConfig.uri_allow_list -split ',') + @("niagacore://auth/callback","niagacore://auth/reset")
  $redirectAllowList = ($redirects | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique) -join ','

  $smtpValues = @{
    external_email_enabled = $true
    mailer_secure_email_change_enabled = $true
    mailer_autoconfirm = $false
    smtp_admin_email = $SenderEmail
    smtp_host = $SmtpHost
    smtp_port = $SmtpPort
    smtp_user = $SmtpUser
    smtp_pass = $smtpPassword
    smtp_sender_name = $SenderName
  }
  $smtpExpected = @{
    external_email_enabled = $true
    smtp_admin_email = $SenderEmail
    smtp_host = $SmtpHost
    smtp_port = $SmtpPort
    smtp_user = $SmtpUser
    smtp_sender_name = $SenderName
  }
  Set-AuthConfig $smtpValues $smtpExpected "Konfigurasi SMTP"

  $templateValues = @{
    mailer_subjects_invite = "Undangan akses staf NiagaCore"
    mailer_templates_invite_content = Get-Content (Join-Path $root "supabase/email-templates/invite.html") -Raw
    mailer_subjects_recovery = "Akses akun NiagaCore"
    mailer_templates_recovery_content = Get-Content (Join-Path $root "supabase/email-templates/recovery.html") -Raw
    uri_allow_list = $redirectAllowList
  }
  $templateExpected = @{
    mailer_subjects_invite = "Undangan akses staf NiagaCore"
    mailer_subjects_recovery = "Akses akun NiagaCore"
    uri_allow_list = $redirectAllowList
  }
  Set-AuthConfig $templateValues $templateExpected "Template dan deep link"

  Write-Host "[4/5] Memasang deep link Edge Function..."
  & npx supabase secrets set "APP_DEEP_LINK_URL=niagacore://auth/callback" "APP_PASSWORD_RESET_DEEP_LINK_URL=niagacore://auth/reset" --project-ref $ProjectRef
  if ($LASTEXITCODE -ne 0) { throw "Gagal menyimpan secret Edge Function." }

  Write-Host "[5/5] Deploy ulang fungsi undangan..."
  & npx supabase functions deploy invite-staff --project-ref $ProjectRef --use-api
  if ($LASTEXITCODE -ne 0) { throw "Gagal deploy invite-staff." }

  Write-Host "SELESAI: email usaha, template, deep link, dan fungsi undangan sudah aktif." -ForegroundColor Green
  Write-Host "Tunggu satu menit, lalu kirim undangan ke email baru dan periksa folder Spam." -ForegroundColor Green
} catch {
  Write-Host "GAGAL: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  Remove-Item Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue
  Remove-Variable accessToken,smtpPassword,smtpPasswordSecure -ErrorAction SilentlyContinue
}
