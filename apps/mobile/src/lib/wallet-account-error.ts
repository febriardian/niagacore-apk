type FunctionError = { message?: string; context?: unknown };

export function walletAccountErrorMessage(code?: string | null): string {
  if (code === "not_configured" || code === "invalid_encryption_configuration") return "Layanan rekening belum aktif sepenuhnya. Selesaikan konfigurasi keamanan server lalu coba kembali.";
  if (code === "authentication_required") return "Sesi login telah berakhir. Masuk kembali lalu ulangi penyimpanan rekening.";
  if (code === "owner_required") return "Hanya pemilik usaha yang dapat menambahkan rekening pencairan.";
  if (code === "invalid_bank_account") return "Periksa kembali bank, nama pemilik, dan nomor rekening.";
  if (code === "tenant_required") return "Data usaha belum siap. Muat ulang aplikasi lalu coba kembali.";
  return "Rekening belum berhasil disimpan. Periksa koneksi lalu coba kembali.";
}

export async function explainWalletAccountError(error: unknown): Promise<string> {
  const value = (error ?? {}) as FunctionError;
  const context = value.context;
  if (context && typeof context === "object" && "clone" in context) {
    try {
      const payload = await (context as Response).clone().json() as {error?:string};
      return walletAccountErrorMessage(payload.error);
    } catch { /* use the safe fallback below */ }
  }
  return walletAccountErrorMessage(value.message);
}
