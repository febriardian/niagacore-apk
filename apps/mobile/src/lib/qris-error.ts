type FunctionErrorBody = {
  error?: string;
  message?: string;
  details?: string;
  hint?: string;
  traceId?: string;
  requestId?: string;
  provider?: { status_message?: string };
};

const messages: Record<string, string> = {
  authentication_required: "Sesi pembayaran sudah tidak valid. Masuk kembali lalu coba lagi.",
  midtrans_not_configured: "Layanan QRIS belum dikonfigurasi pada server produksi.",
  invalid_payment_request: "Data pembayaran QRIS belum lengkap. Muat ulang kasir lalu coba lagi.",
  qris_not_enabled: "QRIS merchant belum diaktifkan oleh admin.",
  qris_channel_not_activated: "Metode QRIS belum tersedia dari konfigurasi pembayaran saat ini. Admin perlu memeriksa kanal pembayaran yang digunakan.",
  midtrans_charge_failed: "Permintaan QRIS ditolak oleh Midtrans. Admin perlu memeriksa aktivasi dan konfigurasi akun Midtrans.",
  qris_payload_missing: "Midtrans tidak mengirimkan kode QR pembayaran. Coba lagi atau hubungi admin.",
  qris_session_persistence_failed: "Status QRIS belum dapat disimpan. Jangan ulangi pembayaran sebelum admin memeriksa transaksi ini.",
};

function fromBody(body: FunctionErrorBody) {
  const combined = [body.error, body.message, body.details, body.hint]
    .filter(Boolean)
    .join(" ");
  const known = Object.entries(messages).find(([code]) => combined.includes(code));
  const message = known?.[1] ?? body.provider?.status_message ?? "QRIS gagal diproses oleh server. Coba lagi setelah beberapa saat.";
  const reference = body.traceId ?? body.requestId;
  return reference ? `${message}\nReferensi: ${reference}` : message;
}

export async function qrisCheckoutErrorMessage(error: unknown) {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.clone === "function") {
    try {
      return fromBody(await context.clone().json() as FunctionErrorBody);
    } catch {
      // Gunakan pesan aman di bawah ketika respons server bukan JSON.
    }
  }
  const raw = error instanceof Error ? error.message : String(error);
  const known = Object.entries(messages).find(([code]) => raw.includes(code));
  return known?.[1] ?? "QRIS gagal diproses oleh server. Periksa koneksi lalu coba lagi.";
}
