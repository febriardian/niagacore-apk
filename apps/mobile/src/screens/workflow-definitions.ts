import type { Role } from "@niagacore/contracts";
import type { RecordKind } from "@/lib/remote-store";

export type WorkflowField = {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "choice" | "boolean";
  required?: boolean;
  options?: readonly { value: string; label: string }[];
  help?: string;
};

export type WorkflowTransition = {
  from: readonly string[];
  to: string;
  label: string;
  roles?: readonly Role[];
  confirm?: string;
};

export type ModuleDefinition = {
  kind: RecordKind;
  title: string;
  description: string;
  icon: string;
  group: string;
  amountLabel?: string;
  quantityLabel?: string;
  dueLabel?: string;
  initialStatus: string;
  fields: readonly WorkflowField[];
  transitions: readonly WorkflowTransition[];
};

const ownerSupervisor = ["owner", "supervisor"] as const;
const lifecycle = (
  draftTo: string,
  final: string,
  submitLabel = "Ajukan",
): readonly WorkflowTransition[] => [
  { from: ["draft"], to: draftTo, label: submitLabel },
  {
    from: [draftTo],
    to: final,
    label: final === "posted" ? "Setujui & posting" : "Selesaikan",
    roles: ownerSupervisor,
    confirm: "Tindakan ini membuat event operasional dan jejak audit baru.",
  },
  {
    from: ["draft", draftTo],
    to: "cancelled",
    label: "Batalkan",
    roles: ownerSupervisor,
  },
];

const contactFields: readonly WorkflowField[] = [
  { key: "phone", label: "Nomor telepon", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "address", label: "Alamat", type: "text" },
];

export const modules: readonly ModuleDefinition[] = [
  {
    kind: "customer",
    title: "Pelanggan",
    description: "Data pelanggan, izin komunikasi, dan program loyalitas",
    icon: "◎",
    group: "Relasi",
    initialStatus: "active",
    fields: [
      ...contactFields,
      { key: "consent", label: "Izin komunikasi", type: "boolean" },
      { key: "creditLimitMinor", label: "Batas piutang (Rp)", type: "number" },
    ],
    transitions: [
      { from: ["active"], to: "blocked", label: "Blokir", roles: ownerSupervisor },
      { from: ["blocked"], to: "active", label: "Aktifkan", roles: ownerSupervisor },
    ],
  },
  {
    kind: "supplier",
    title: "Pemasok",
    description: "Data pemasok, cara pembayaran, dan status kerja sama",
    icon: "◇",
    group: "Relasi",
    initialStatus: "active",
    fields: [
      ...contactFields,
      { key: "paymentTermsDays", label: "Tempo pembayaran (hari)", type: "number" },
      { key: "leadTimeDays", label: "Lead time (hari)", type: "number" },
    ],
    transitions: [
      { from: ["active"], to: "inactive", label: "Nonaktifkan", roles: ownerSupervisor },
      { from: ["inactive"], to: "active", label: "Aktifkan", roles: ownerSupervisor },
    ],
  },
  {
    kind: "purchase_order",
    title: "Pesanan pembelian",
    description: "Pesanan barang, pemasok, persetujuan, dan penerimaan",
    icon: "▤",
    group: "Pembelian",
    amountLabel: "Total PO (Rp)",
    dueLabel: "Target barang datang",
    initialStatus: "draft",
    fields: [
      { key: "supplierId", label: "Pilih pemasok", type: "text", required: true },
      { key: "items", label: "Item (SKU:qty:harga, pisahkan koma)", type: "text", required: true },
      { key: "paymentTerms", label: "Syarat pembayaran", type: "text" },
    ],
    transitions: [
      { from: ["draft"], to: "submitted", label: "Ajukan PO" },
      { from: ["submitted"], to: "approved", label: "Setujui", roles: ownerSupervisor },
      { from: ["approved"], to: "partially_received", label: "Terima sebagian", roles: ownerSupervisor },
      { from: ["approved", "partially_received"], to: "received", label: "Tandai diterima", roles: ownerSupervisor },
      { from: ["draft", "submitted", "approved"], to: "cancelled", label: "Batalkan", roles: ownerSupervisor },
    ],
  },
  {
    kind: "goods_receipt",
    title: "Penerimaan barang",
    description: "Catat barang datang dan tambahkan stok",
    icon: "⇣",
    group: "Pembelian",
    amountLabel: "Nilai barang (Rp)",
    quantityLabel: "Jumlah diterima",
    initialStatus: "draft",
    fields: [
      { key: "purchaseOrderId", label: "Pilih pesanan pembelian", type: "text" },
      { key: "productId", label: "Pilih produk", type: "text", required: true },
      { key: "warehouseId", label: "Gudang tujuan", type: "text" },
      { key: "lotNumber", label: "Nomor batch/lot", type: "text" },
    ],
    transitions: lifecycle("checked", "posted", "Periksa penerimaan"),
  },
  {
    kind: "supplier_bill",
    title: "Tagihan pemasok",
    description: "Catat tagihan pemasok, pajak, dan jatuh tempo",
    icon: "▧",
    group: "Pembelian",
    amountLabel: "Total tagihan (Rp)",
    dueLabel: "Jatuh tempo",
    initialStatus: "draft",
    fields: [
      { key: "supplierId", label: "Pilih pemasok", type: "text", required: true },
      { key: "invoiceNumber", label: "Nomor invoice", type: "text", required: true },
      { key: "taxMinor", label: "Pajak masukan (Rp)", type: "number" },
      { key: "goodsReceiptId", label: "Pilih penerimaan barang", type: "text" },
    ],
    transitions: lifecycle("verified", "posted", "Verifikasi tagihan"),
  },
  {
    kind: "purchase_return",
    title: "Retur pembelian",
    description: "Catat barang yang dikembalikan kepada pemasok",
    icon: "↶",
    group: "Pembelian",
    amountLabel: "Nilai retur (Rp)",
    quantityLabel: "Jumlah retur",
    initialStatus: "draft",
    fields: [
      { key: "supplierId", label: "Pilih pemasok", type: "text", required: true },
      { key: "productId", label: "Pilih produk", type: "text", required: true },
      { key: "reason", label: "Alasan retur", type: "text", required: true },
    ],
    transitions: lifecycle("approved", "posted"),
  },
  {
    kind: "payable",
    title: "Utang usaha",
    description: "Pantau tagihan dan pembayaran kepada pemasok",
    icon: "−",
    group: "Keuangan",
    amountLabel: "Saldo utang (Rp)",
    dueLabel: "Jatuh tempo",
    initialStatus: "open",
    fields: [
      { key: "supplierId", label: "Pilih pemasok", type: "text", required: true },
      { key: "paidMinor", label: "Sudah dibayar (Rp)", type: "number" },
      { key: "paymentAccount", label: "Bayar dari", type: "choice", options: [
        { value: "cash", label: "Kas" }, { value: "bank", label: "Bank" },
      ] },
    ],
    transitions: [
      { from: ["open"], to: "partially_paid", label: "Catat bayar sebagian", roles: ownerSupervisor },
      { from: ["open", "partially_paid"], to: "paid", label: "Lunasi", roles: ownerSupervisor },
    ],
  },
  {
    kind: "receivable",
    title: "Piutang usaha",
    description: "Pantau tagihan dan pembayaran dari pelanggan",
    icon: "＋",
    group: "Keuangan",
    amountLabel: "Saldo piutang (Rp)",
    dueLabel: "Jatuh tempo",
    initialStatus: "open",
    fields: [
      { key: "customerId", label: "Pilih pelanggan", type: "text", required: true },
      { key: "receivedMinor", label: "Sudah diterima (Rp)", type: "number" },
      { key: "receiptAccount", label: "Diterima ke", type: "choice", options: [
        { value: "cash", label: "Kas" }, { value: "bank", label: "Bank" },
      ] },
    ],
    transitions: [
      { from: ["open"], to: "partially_paid", label: "Terima sebagian", roles: ownerSupervisor },
      { from: ["open", "partially_paid"], to: "paid", label: "Tandai lunas", roles: ownerSupervisor },
    ],
  },
  {
    kind: "expense",
    title: "Pengeluaran",
    description: "Catat pengeluaran, pajak, dan bukti pembayaran",
    icon: "↗",
    group: "Keuangan",
    amountLabel: "Nominal (Rp)",
    initialStatus: "draft",
    fields: [
      { key: "category", label: "Kategori beban", type: "text", required: true },
      { key: "paidFrom", label: "Dibayar dari", type: "choice", options: [
        { value: "cash", label: "Kas" }, { value: "bank", label: "Bank" },
      ], required: true },
      { key: "taxMinor", label: "Pajak masukan (Rp)", type: "number" },
      { key: "attachment", label: "Referensi bukti", type: "text" },
    ],
    transitions: lifecycle("approved", "posted"),
  },
  {
    kind: "manual_journal",
    title: "Jurnal manual",
    description: "Catat debit dan kredit dengan pemeriksaan keseimbangan",
    icon: "≋",
    group: "Akuntansi",
    amountLabel: "Total debit/kredit (Rp)",
    initialStatus: "draft",
    fields: [
      { key: "journalLines", label: "Baris jurnal", type: "text", required: true },
      { key: "explanation", label: "Penjelasan", type: "text", required: true },
      { key: "attachment", label: "Referensi lampiran", type: "text" },
    ],
    transitions: [
      { from: ["draft"], to: "pending_approval", label: "Ajukan jurnal" },
      { from: ["pending_approval"], to: "posted", label: "Setujui & posting", roles: ["owner"], confirm: "Setelah disetujui, perubahan dicatat sebagai koreksi baru agar riwayat tetap lengkap." },
      { from: ["posted"], to: "reversed", label: "Buat reversal", roles: ["owner"] },
    ],
  },
  {
    kind: "fiscal_period",
    title: "Periode akuntansi",
    description: "Atur periode laporan yang masih dapat digunakan",
    icon: "▦",
    group: "Akuntansi",
    dueLabel: "Tanggal akhir periode",
    initialStatus: "open",
    fields: [
      { key: "startDate", label: "Tanggal mulai", type: "date", required: true },
      { key: "closeNote", label: "Catatan penutupan", type: "text" },
    ],
    transitions: [
      { from: ["open"], to: "soft_closed", label: "Soft close", roles: ["owner"] },
      { from: ["soft_closed"], to: "hard_closed", label: "Hard close", roles: ["owner"], confirm: "Posting baru pada periode ini akan ditolak server." },
      { from: ["soft_closed", "hard_closed"], to: "open", label: "Reopen berizin", roles: ["owner"] },
    ],
  },
  {
    kind: "asset",
    title: "Aset tetap",
    description: "Catat nilai aset dan perhitungan penyusutan",
    icon: "▰",
    group: "Akuntansi",
    amountLabel: "Nilai perolehan (Rp)",
    dueLabel: "Tanggal perolehan",
    initialStatus: "draft",
    fields: [
      { key: "usefulLifeMonths", label: "Umur manfaat (bulan)", type: "number", required: true },
      { key: "residualMinor", label: "Nilai residu (Rp)", type: "number" },
      { key: "assetAccount", label: "Akun aset", type: "text" },
      { key: "depreciationAccount", label: "Akun akumulasi", type: "text" },
    ],
    transitions: [
      { from: ["draft"], to: "active", label: "Kapitalisasi", roles: ["owner"] },
      { from: ["active"], to: "disposed", label: "Lepas aset", roles: ["owner"] },
    ],
  },
  {
    kind: "tax",
    title: "Kebijakan pajak",
    description: "Atur kode, tarif, dan cara perhitungan pajak",
    icon: "%",
    group: "Akuntansi",
    initialStatus: "draft",
    fields: [
      { key: "rate", label: "Tarif (%)", type: "number", required: true },
      { key: "effectiveFrom", label: "Berlaku mulai", type: "date", required: true },
      { key: "policyVersion", label: "Versi kebijakan", type: "number", required: true },
      { key: "calculation", label: "Perhitungan", type: "choice", options: [
        { value: "inclusive", label: "Inklusif" }, { value: "exclusive", label: "Eksklusif" },
      ] },
      { key: "taxAccount", label: "Akun pajak", type: "text" },
      { key: "coretaxCode", label: "Kode pemetaan ekspor Coretax", type: "text" },
    ],
    transitions: [
      { from: ["draft"], to: "active", label: "Aktifkan kebijakan", roles: ["owner"] },
      { from: ["active"], to: "expired", label: "Akhiri kebijakan", roles: ["owner"] },
    ],
  },
  {
    kind: "stock_count",
    title: "Stok opname",
    description: "Bandingkan stok fisik dengan stok aplikasi",
    icon: "✓",
    group: "Persediaan",
    quantityLabel: "Stok fisik",
    initialStatus: "draft",
    fields: [
      { key: "productId", label: "Pilih produk", type: "text", required: true },
      { key: "systemQuantity", label: "Stok sistem", type: "number", required: true },
      { key: "reason", label: "Alasan selisih", type: "text" },
    ],
    transitions: lifecycle("review", "posted", "Kirim untuk review"),
  },
  {
    kind: "stock_transfer",
    title: "Transfer stok",
    description: "Pindahkan stok antar cabang atau gudang",
    icon: "⇄",
    group: "Persediaan",
    quantityLabel: "Jumlah transfer",
    initialStatus: "draft",
    fields: [
      { key: "productId", label: "Pilih produk", type: "text", required: true },
      { key: "sourceBranchId", label: "Cabang/gudang asal", type: "text", required: true },
      { key: "destinationBranchId", label: "Cabang/gudang tujuan", type: "text", required: true },
    ],
    transitions: [
      { from: ["draft"], to: "approved", label: "Setujui transfer", roles: ownerSupervisor },
      { from: ["approved"], to: "in_transit", label: "Kirim barang", roles: ownerSupervisor },
      { from: ["in_transit"], to: "received", label: "Terima barang", roles: ownerSupervisor },
      { from: ["draft", "approved"], to: "cancelled", label: "Batalkan", roles: ownerSupervisor },
    ],
  },
  {
    kind: "lot",
    title: "Batch & kedaluwarsa",
    description: "Pantau batch, jumlah, dan tanggal kedaluwarsa",
    icon: "⌁",
    group: "Persediaan",
    quantityLabel: "Kuantitas lot",
    dueLabel: "Tanggal kedaluwarsa",
    initialStatus: "available",
    fields: [
      { key: "productId", label: "Pilih produk", type: "text", required: true },
      { key: "receivedAt", label: "Tanggal diterima", type: "date" },
      { key: "costMinor", label: "HPP per unit (Rp)", type: "number" },
    ],
    transitions: [
      { from: ["available"], to: "quarantined", label: "Karantina", roles: ownerSupervisor },
      { from: ["quarantined"], to: "available", label: "Lepas karantina", roles: ownerSupervisor },
      { from: ["available", "quarantined"], to: "expired", label: "Tandai kedaluwarsa", roles: ownerSupervisor },
    ],
  },
  {
    kind: "price_list",
    title: "Daftar harga",
    description: "Atur harga eceran, grosir, dan masa berlaku",
    icon: "₨",
    group: "Katalog",
    amountLabel: "Harga (Rp)",
    quantityLabel: "Minimum kuantitas",
    dueLabel: "Berlaku sampai",
    initialStatus: "draft",
    fields: [
      { key: "productId", label: "Pilih produk", type: "text", required: true },
      { key: "customerSegmentId", label: "Segmen pelanggan", type: "text" },
      { key: "effectiveFrom", label: "Berlaku mulai", type: "date", required: true },
    ],
    transitions: [
      { from: ["draft"], to: "active", label: "Aktifkan harga", roles: ["owner"] },
      { from: ["active"], to: "expired", label: "Akhiri harga", roles: ["owner"] },
    ],
  },
  {
    kind: "bundle",
    title: "Bundel produk",
    description: "Paket produk, komponen, jumlah, dan harga gabungan",
    icon: "◫",
    group: "Katalog",
    amountLabel: "Harga bundel (Rp)",
    initialStatus: "draft",
    fields: [
      { key: "components", label: "Komponen produk", type: "text", required: true },
      { key: "barcode", label: "Barcode bundel", type: "text" },
    ],
    transitions: [
      { from: ["draft"], to: "active", label: "Aktifkan bundel", roles: ownerSupervisor },
      { from: ["active"], to: "inactive", label: "Nonaktifkan", roles: ownerSupervisor },
    ],
  },
  {
    kind: "recipe",
    title: "Resep / BOM",
    description: "Atur hasil, bahan, dan takaran resep",
    icon: "⌘",
    group: "F&B",
    quantityLabel: "Yield resep",
    initialStatus: "draft",
    fields: [
      { key: "outputProductId", label: "Pilih produk hasil", type: "text", required: true },
      { key: "ingredients", label: "Bahan resep", type: "text", required: true },
      { key: "wastePercent", label: "Susut (%)", type: "number" },
    ],
    transitions: [
      { from: ["draft"], to: "active", label: "Aktifkan resep", roles: ownerSupervisor },
      { from: ["active"], to: "superseded", label: "Ganti versi", roles: ownerSupervisor },
    ],
  },
  {
    kind: "modifier",
    title: "Modifier",
    description: "Atur pilihan menu dan tambahan harga",
    icon: "＋",
    group: "F&B",
    amountLabel: "Tambahan harga (Rp)",
    initialStatus: "active",
    fields: [
      { key: "productId", label: "Pilih produk/menu", type: "text", required: true },
      { key: "required", label: "Wajib dipilih", type: "boolean" },
      { key: "maxSelections", label: "Maksimum pilihan", type: "number" },
    ],
    transitions: [
      { from: ["active"], to: "inactive", label: "Nonaktifkan", roles: ownerSupervisor },
      { from: ["inactive"], to: "active", label: "Aktifkan", roles: ownerSupervisor },
    ],
  },
  {
    kind: "dining_table",
    title: "Meja",
    description: "Kapasitas, area, status, dan pesanan aktif",
    icon: "□",
    group: "F&B",
    quantityLabel: "Kapasitas kursi",
    initialStatus: "available",
    fields: [
      { key: "area", label: "Area", type: "text" },
      { key: "activeOrderId", label: "ID pesanan aktif", type: "text" },
    ],
    transitions: [
      { from: ["available"], to: "occupied", label: "Buka meja" },
      { from: ["occupied"], to: "billing", label: "Minta tagihan" },
      { from: ["billing"], to: "cleaning", label: "Pembayaran selesai" },
      { from: ["cleaning"], to: "available", label: "Meja siap" },
      { from: ["available"], to: "reserved", label: "Reservasi" },
      { from: ["reserved"], to: "occupied", label: "Tamu datang" },
    ],
  },
  {
    kind: "kitchen_order",
    title: "Pesanan dapur",
    description: "Pantau antrean dan status pesanan dapur",
    icon: "≡",
    group: "F&B",
    initialStatus: "queued",
    fields: [
      { key: "tableId", label: "Meja/pesanan", type: "text" },
      { key: "items", label: "Item dan modifier", type: "text", required: true },
      { key: "priority", label: "Prioritas", type: "choice", options: [
        { value: "normal", label: "Normal" }, { value: "rush", label: "Prioritas" },
      ] },
    ],
    transitions: [
      { from: ["queued"], to: "preparing", label: "Mulai masak" },
      { from: ["preparing"], to: "ready", label: "Siap disajikan" },
      { from: ["ready"], to: "served", label: "Sudah disajikan" },
      { from: ["queued"], to: "cancelled", label: "Batalkan", roles: ownerSupervisor },
    ],
  },
  {
    kind: "service",
    title: "Layanan",
    description: "Atur harga, durasi, staf, dan jadwal layanan",
    icon: "◷",
    group: "Jasa",
    amountLabel: "Harga layanan (Rp)",
    quantityLabel: "Durasi (menit)",
    initialStatus: "active",
    fields: [
      { key: "staffIds", label: "ID staf yang tersedia", type: "text" },
      { key: "bufferMinutes", label: "Jeda antarjadwal (menit)", type: "number" },
    ],
    transitions: [
      { from: ["active"], to: "inactive", label: "Nonaktifkan", roles: ownerSupervisor },
      { from: ["inactive"], to: "active", label: "Aktifkan", roles: ownerSupervisor },
    ],
  },
  {
    kind: "appointment",
    title: "Jadwal layanan",
    description: "Atur pelanggan, waktu, staf, dan status layanan",
    icon: "◴",
    group: "Jasa",
    dueLabel: "Tanggal & waktu mulai",
    initialStatus: "booked",
    fields: [
      { key: "customerId", label: "Pilih pelanggan", type: "text", required: true },
      { key: "serviceId", label: "Pilih layanan", type: "text", required: true },
      { key: "staffId", label: "ID staf", type: "text" },
      { key: "durationMinutes", label: "Durasi (menit)", type: "number", required: true },
    ],
    transitions: [
      { from: ["booked"], to: "confirmed", label: "Konfirmasi" },
      { from: ["confirmed"], to: "in_progress", label: "Mulai layanan" },
      { from: ["in_progress"], to: "completed", label: "Selesaikan" },
      { from: ["booked", "confirmed"], to: "cancelled", label: "Batalkan" },
      { from: ["booked", "confirmed"], to: "no_show", label: "Tidak hadir" },
    ],
  },
  {
    kind: "customer_segment",
    title: "Segmen pelanggan",
    description: "Kelompokkan pelanggan berdasarkan aktivitas belanja",
    icon: "◉",
    group: "CRM",
    initialStatus: "active",
    fields: [
      { key: "recencyDays", label: "Recency maksimum (hari)", type: "number" },
      { key: "frequencyMin", label: "Frekuensi minimum", type: "number" },
      { key: "monetaryMinMinor", label: "Belanja minimum (Rp)", type: "number" },
    ],
    transitions: [
      { from: ["active"], to: "inactive", label: "Nonaktifkan", roles: ownerSupervisor },
      { from: ["inactive"], to: "active", label: "Aktifkan", roles: ownerSupervisor },
    ],
  },
  {
    kind: "loyalty",
    title: "Loyalitas",
    description: "Kelola poin pelanggan dan riwayat penyesuaian",
    icon: "★",
    group: "CRM",
    quantityLabel: "Perubahan poin",
    initialStatus: "draft",
    fields: [
      { key: "customerId", label: "Pilih pelanggan", type: "text", required: true },
      { key: "direction", label: "Jenis", type: "choice", options: [
        { value: "earn", label: "Tambah poin" }, { value: "redeem", label: "Tukar poin" }, { value: "adjust", label: "Penyesuaian" },
      ], required: true },
      { key: "reason", label: "Alasan", type: "text", required: true },
    ],
    transitions: lifecycle("approved", "posted"),
  },
  {
    kind: "staff",
    title: "Staf & akses",
    description: "Atur akun, peran, cabang, dan status staf",
    icon: "♙",
    group: "Pengaturan",
    initialStatus: "invited",
    fields: [
      { key: "email", label: "Email staf", type: "text", required: true },
      { key: "role", label: "Peran", type: "choice", options: [
        { value: "cashier", label: "Kasir" }, { value: "supervisor", label: "Supervisor" }, { value: "owner", label: "Pemilik" },
      ], required: true },
      { key: "branchIds", label: "Cabang yang diizinkan", type: "text" },
      { key: "permissions", label: "Permission tambahan", type: "text" },
    ],
    transitions: [
      { from: ["invited"], to: "active", label: "Aktifkan", roles: ["owner"] },
      { from: ["active"], to: "suspended", label: "Tangguhkan", roles: ["owner"] },
      { from: ["suspended"], to: "active", label: "Pulihkan", roles: ["owner"] },
    ],
  },
  {
    kind: "device",
    title: "Perangkat",
    description: "Kelola perangkat yang pernah digunakan untuk login",
    icon: "▯",
    group: "Pengaturan",
    initialStatus: "active",
    fields: [
      { key: "platform", label: "Platform/Android", type: "text" },
      { key: "publicKeyFingerprint", label: "Fingerprint public key", type: "text" },
      { key: "offlineGraceHours", label: "Batas offline (jam)", type: "number" },
    ],
    transitions: [
      { from: ["active"], to: "revoked", label: "Cabut perangkat", roles: ["owner"], confirm: "Perangkat akan dikunci dan data lokal dihapus aman saat kembali online." },
    ],
  },
  {
    kind: "hardware",
    title: "Perangkat kasir",
    description: "Atur printer, scanner, laci kas, dan timbangan",
    icon: "⌑",
    group: "Pengaturan",
    initialStatus: "experimental",
    fields: [
      { key: "type", label: "Jenis", type: "choice", options: [
        { value: "printer", label: "Printer" }, { value: "scanner", label: "Scanner" }, { value: "drawer", label: "Laci kas" }, { value: "scale", label: "Timbangan" },
      ], required: true },
      { key: "vendorModel", label: "Merek & model", type: "text", required: true },
      { key: "connection", label: "Koneksi/protokol", type: "text" },
      { key: "testEvidence", label: "Referensi hasil uji fisik", type: "text" },
    ],
    transitions: [
      { from: ["experimental"], to: "supported", label: "Tandai supported", roles: ["owner"], confirm: "Hanya lanjutkan jika uji fisik, disconnect, retry, dan duplikasi cetak sudah lulus." },
      { from: ["supported"], to: "deprecated", label: "Deprecate", roles: ["owner"] },
    ],
  },
  {
    kind: "notification",
    title: "Notifikasi",
    description: "Peringatan operasional dengan status baca dan tindak lanjut",
    icon: "●",
    group: "Pengaturan",
    initialStatus: "unread",
    fields: [
      { key: "severity", label: "Severity", type: "choice", options: [
        { value: "info", label: "Info" }, { value: "warning", label: "Peringatan" }, { value: "critical", label: "Kritis" },
      ] },
      { key: "resourceType", label: "Jenis sumber", type: "text" },
      { key: "resourceId", label: "ID sumber", type: "text" },
    ],
    transitions: [
      { from: ["unread"], to: "read", label: "Tandai dibaca" },
      { from: ["read"], to: "resolved", label: "Selesaikan" },
    ],
  },
] as const;

export function transitionsFor(
  module: ModuleDefinition,
  status: string,
  role: Role,
): readonly WorkflowTransition[] {
  const canApprove = ["owner", "business_manager", "branch_manager", "supervisor"].includes(role);
  const canDoOwnerAccounting = role === "finance" && ["manual_journal", "fiscal_period", "tax", "asset"].includes(module.kind);
  return module.transitions.filter((transition) => {
    if (!transition.from.includes(status)) return false;
    if (!transition.roles) return true;
    if (transition.roles.includes(role)) return true;
    if (transition.roles.includes("supervisor") && canApprove) return true;
    return transition.roles.includes("owner") && (role === "owner" || canDoOwnerAccounting);
  });
}

export function validateWorkflowRecord(
  module: ModuleDefinition,
  input: {
    title: string;
    amountMinor: number;
    quantity: number;
    dueAt: string | null;
    metadata: Record<string, unknown>;
  },
): string | null {
  if (input.title.trim().length < 2) return "Nama atau judul minimal 2 karakter.";
  if (module.amountLabel && (!Number.isFinite(input.amountMinor) || input.amountMinor < 0))
    return `${module.amountLabel} harus berupa angka valid.`;
  if (module.quantityLabel && !Number.isFinite(input.quantity))
    return `${module.quantityLabel} harus berupa angka valid.`;
  if (module.dueLabel && input.dueAt && !/^\d{4}-\d{2}-\d{2}/.test(input.dueAt))
    return `${module.dueLabel} harus memakai format YYYY-MM-DD.`;
  for (const field of module.fields) {
    const value = input.metadata[field.key];
    if (field.required && (value === undefined || value === null || String(value).trim() === "" || (Array.isArray(value) && value.length === 0)))
      return `${field.label} wajib diisi.`;
    if (field.type === "number" && value !== undefined && value !== "" && !Number.isFinite(Number(value)))
      return `${field.label} harus berupa angka valid.`;
    if (field.type === "date" && value && !/^\d{4}-\d{2}-\d{2}/.test(String(value)))
      return `${field.label} harus memakai format YYYY-MM-DD.`;
  }
  if (module.kind === "manual_journal") {
    const lines = Array.isArray(input.metadata.journalLines) ? input.metadata.journalLines as {debitMinor?:unknown;creditMinor?:unknown}[] : [];
    const debit = lines.reduce((sum,line)=>sum+Math.max(0,Math.round(Number(line.debitMinor)||0)),0);
    const credit = lines.reduce((sum,line)=>sum+Math.max(0,Math.round(Number(line.creditMinor)||0)),0);
    if (lines.length < 2) return "Jurnal membutuhkan minimal dua baris.";
    if (debit <= 0 || debit !== credit) return "Total debit dan kredit harus sama serta lebih dari nol.";
  }
  if (module.kind === "receivable" || module.kind === "payable") {
    const settled = Number(input.metadata[module.kind === "receivable" ? "receivedMinor" : "paidMinor"] ?? 0);
    if (settled < 0 || settled > input.amountMinor)
      return "Nilai yang sudah dibayar atau diterima tidak boleh melebihi nilai dokumen.";
  }
  if (module.kind === "asset") {
    const residual = Number(input.metadata.residualMinor ?? 0);
    if (!input.dueAt) return "Tanggal perolehan wajib diisi.";
    if (residual < 0 || residual > input.amountMinor)
      return "Nilai residu tidak boleh melebihi nilai perolehan.";
  }
  if (module.kind === "tax") {
    const rate = Number(input.metadata.rate);
    if (rate < 0 || rate > 100) return "Tarif pajak harus berada di antara 0 dan 100 persen.";
  }
  if (module.kind === "price_list" && input.quantity <= 0)
    return "Minimum kuantitas harus lebih dari nol.";
  if (module.kind === "lot" && input.quantity < 0)
    return "Kuantitas lot tidak boleh negatif.";
  return null;
}
