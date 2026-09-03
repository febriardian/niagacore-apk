import { describe, expect, it } from "vitest";

import { buildReceiptHtml } from "./receipt";

describe("buildReceiptHtml", () => {
  it("creates a native-safe inline SVG verification QR without canvas", async () => {
    const html = await buildReceiptHtml({
      saleId: "11111111-1111-1111-1111-111111111111",
      receiptNumber: "UTAMA-0001",
      businessName: "Toko Uji",
      branchName: "Cabang Utama",
      occurredAt: "2026-08-12T12:00:00.000Z",
      paymentMethod: "cash",
      lines: [{ name: "Produk A", quantity: 2, totalMinor: 20_000 }],
      subtotalMinor: 20_000,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: 20_000,
    });

    expect(html).toContain('<svg class="qr"');
    expect(html).toContain("UTAMA-0001");
    expect(html).toContain("Produk A");
    expect(html).not.toContain("canvas");
    expect(html).not.toContain("data:image");
  });
});
