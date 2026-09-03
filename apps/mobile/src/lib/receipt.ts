import QRCode from "qrcode";

export interface ReceiptLine {
  name: string;
  quantity: number;
  totalMinor: number;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
})[character] ?? character);

const money = (value: number) => new Intl.NumberFormat("id-ID", {
  style: "currency", currency: "IDR", maximumFractionDigits: 0,
}).format(value);

function qrSvg(value: string): string {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const margin = 4;
  const cells: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (qr.modules.get(x, y)) cells.push(`M${x + margin} ${y + margin}h1v1h-1z`);
    }
  }
  const view = size + margin * 2;
  return `<svg class="qr" viewBox="0 0 ${view} ${view}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR verifikasi"><rect width="100%" height="100%" fill="#fff"/><path d="${cells.join("")}" fill="#101820"/></svg>`;
}

export async function buildReceiptHtml(input: {
  saleId: string;
  receiptNumber: string;
  businessName: string;
  branchName: string;
  occurredAt: string;
  paymentMethod: string;
  lines: ReceiptLine[];
  subtotalMinor?: number;
  discountMinor?: number;
  taxMinor?: number;
  totalMinor: number;
  customerName?: string | null;
  paidMinor?: number;
  outstandingMinor?: number;
  dueAt?: string | null;
}): Promise<string> {
  const base = (process.env.EXPO_PUBLIC_RECEIPT_VERIFY_URL ?? "https://niagacore.app/receipt").replace(/\/$/, "");
  const verificationUrl = `${base}/${encodeURIComponent(input.saleId)}`;
  const qr = qrSvg(verificationUrl);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
    @page{margin:12px}body{font-family:Arial,sans-serif;color:#101820;font-size:12px;max-width:320px;margin:auto}
    h1{text-align:center;font-size:18px;margin:0}.muted{text-align:center;color:#5b6672;line-height:1.55}.line{display:flex;justify-content:space-between;gap:14px;margin:7px 0}
    .total{border-top:1px dashed #26323d;padding-top:9px;font-weight:700;font-size:14px}.qr{display:block;width:126px;height:126px;margin:14px auto 4px}.verify{text-align:center;font-size:9px;word-break:break-all;color:#5b6672}
  </style></head><body>
    <h1>${escapeHtml(input.businessName)}</h1><div class="muted">${escapeHtml(input.branchName)}<br>${escapeHtml(input.receiptNumber)}<br>${escapeHtml(new Date(input.occurredAt).toLocaleString("id-ID"))}<br>${escapeHtml(input.paymentMethod.toUpperCase())}</div>
    ${input.customerName ? `<p>Pelanggan: ${escapeHtml(input.customerName)}</p>` : ""}
    ${input.lines.map((line) => `<div class="line"><span>${escapeHtml(line.name)} × ${line.quantity}</span><span>${escapeHtml(money(line.totalMinor))}</span></div>`).join("")}
    ${input.subtotalMinor == null ? "" : `<div class="line"><span>Subtotal</span><span>${escapeHtml(money(input.subtotalMinor))}</span></div>`}
    ${input.discountMinor ? `<div class="line"><span>Diskon</span><span>-${escapeHtml(money(input.discountMinor))}</span></div>` : ""}
    ${input.taxMinor == null ? "" : `<div class="line"><span>Pajak</span><span>${escapeHtml(money(input.taxMinor))}</span></div>`}
    <div class="line total"><span>Total</span><span>${escapeHtml(money(input.totalMinor))}</span></div>
    ${input.paidMinor == null ? "" : `<div class="line"><span>Dibayar</span><span>${escapeHtml(money(input.paidMinor))}</span></div>`}
    ${input.outstandingMinor == null ? "" : `<div class="line total"><span>Sisa piutang</span><span>${escapeHtml(money(input.outstandingMinor))}</span></div>`}
    ${input.dueAt ? `<div class="muted">Jatuh tempo: ${escapeHtml(input.dueAt)}</div>` : ""}
    ${qr}<div class="verify">Pindai untuk memverifikasi struk<br>${escapeHtml(verificationUrl)}</div>
    <p class="muted">Terima kasih</p></body></html>`;
}
