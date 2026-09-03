$ErrorActionPreference = "Stop"

$walletKeyBytes = New-Object byte[] 32
$walletRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $walletRng.GetBytes($walletKeyBytes)
} finally {
  $walletRng.Dispose()
}
$walletKey = [Convert]::ToBase64String($walletKeyBytes)

Write-Host "Mengaktifkan keamanan rekening pencairan..."
npx supabase secrets set "WALLET_ENCRYPTION_KEY_BASE64=$walletKey"
if ($LASTEXITCODE -ne 0) { throw "Gagal menyimpan konfigurasi keamanan rekening." }

Write-Host "Memasang layanan rekening..."
npx supabase functions deploy wallet-account
if ($LASTEXITCODE -ne 0) { throw "Gagal memasang layanan rekening." }

Write-Host "Layanan rekening berhasil diaktifkan. Tutup lalu buka kembali aplikasi."
