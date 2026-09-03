import { describe, expect, it } from "vitest";

import { qrisCheckoutErrorMessage } from "./qris-error";

describe("qrisCheckoutErrorMessage", () => {
  it("menjelaskan konfigurasi server tanpa menampilkan pesan teknis SDK", async () => {
    const error = {
      message: "Edge Function returned a non-2xx status code",
      context: new Response(JSON.stringify({ error: "midtrans_not_configured", traceId: "trace-123" })),
    };

    await expect(qrisCheckoutErrorMessage(error)).resolves.toBe(
      "Layanan QRIS belum dikonfigurasi pada server produksi.\nReferensi: trace-123",
    );
  });

  it("menjelaskan ketika kanal pembayaran belum cocok", async () => {
    const error = {
      context: new Response(JSON.stringify({
        error: "qris_channel_not_activated",
        traceId: "trace-channel",
      })),
    };

    await expect(qrisCheckoutErrorMessage(error)).resolves.toBe(
      "Metode QRIS belum tersedia dari konfigurasi pembayaran saat ini. Admin perlu memeriksa kanal pembayaran yang digunakan.\nReferensi: trace-channel",
    );
  });

  it("memberi pesan aman jika body error tidak dapat dibaca", async () => {
    await expect(qrisCheckoutErrorMessage(new Error("Edge Function returned a non-2xx status code")))
      .resolves.toBe("QRIS gagal diproses oleh server. Periksa koneksi lalu coba lagi.");
  });
});
