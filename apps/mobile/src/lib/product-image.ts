export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;

export function decodeProductImageBase64(value: string): ArrayBuffer {
  const payload = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = globalThis.atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function productImageErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("product_image_too_large")) return "Ukuran foto melebihi batas 5 MB. Pilih foto yang lebih kecil.";
  if (message.includes("product_image_read_failed")) return "Foto tidak dapat dibaca. Pilih foto lain dari galeri lalu coba kembali.";
  if (/bucket.*not found/i.test(message)) return "Penyimpanan foto produk belum aktif. Pastikan migration product_images sudah dipasang.";
  if (/row-level security|permission|not authorized|unauthorized/i.test(message)) return "Akun ini tidak memiliki izin untuk mengunggah foto produk.";
  if (/network|fetch|timeout/i.test(message)) return "Foto belum berhasil diunggah. Periksa koneksi lalu coba kembali.";
  return "Foto belum berhasil diunggah. Silakan pilih ulang foto dan coba kembali.";
}
