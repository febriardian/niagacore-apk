import type { Permission, Role } from "@niagacore/contracts";

const rolePermissions = {
  cashier: [
    "sales.create.branch",
    "sales.read.own",
    "customers.read.branch",
    "shift.manage.own",
    "receipts.read.own",
  ],
  supervisor: [
    "sales.create.branch",
    "sales.read.branch",
    "sales.refund.branch",
    "customers.read.branch",
    "inventory.manage.branch",
    "shift.manage.branch",
    "receipts.read.branch",
    "approvals.manage.branch",
  ],
  owner: [
    "sales.create.business",
    "sales.read.business",
    "sales.refund.business",
    "customers.manage.business",
    "inventory.manage.business",
    "accounting.manage.business",
    "members.manage.tenant",
    "devices.manage.tenant",
    "reports.read.business",
    "approvals.manage.business",
    "settings.manage.business",
  ],
  business_manager: [
    "sales.read.business", "sales.refund.business", "customers.manage.business",
    "inventory.manage.business", "accounting.read.business", "reports.read.business",
    "members.manage.tenant", "approvals.manage.business",
  ],
  branch_manager: [
    "sales.create.branch", "sales.read.branch", "sales.refund.branch",
    "customers.manage.branch", "inventory.manage.branch", "accounting.read.branch",
    "reports.read.branch", "shift.manage.branch", "approvals.manage.branch",
  ],
  warehouse: [
    "inventory.manage.branch", "products.read.branch", "purchases.read.branch",
    "purchases.receive.branch", "transfers.manage.branch",
  ],
  purchasing: [
    "products.read.business", "inventory.read.business", "suppliers.manage.business",
    "purchases.manage.business", "payables.read.business",
  ],
  finance: [
    "sales.read.business", "accounting.manage.business", "reports.read.business",
    "receivables.manage.business", "payables.manage.business", "expenses.manage.business",
  ],
  service_staff: [
    "customers.read.branch", "appointments.manage.own", "services.read.branch",
    "sales.read.own",
  ],
  kitchen: ["kitchen.manage.branch", "products.read.branch", "inventory.read.branch"],
  waiter: [
    "sales.create.branch", "sales.read.own", "customers.read.branch",
    "tables.manage.branch", "kitchen.read.branch",
  ],
  auditor: [
    "sales.read.business", "inventory.read.business", "accounting.read.business",
    "reports.read.business", "audit.read.tenant",
  ],
} as const satisfies Record<Role, readonly Permission[]>;

export const roleCatalog: ReadonlyArray<{
  value: Role;
  label: string;
  summary: string;
}> = [
  { value: "owner", label: "Pemilik", summary: "Kontrol penuh usaha dan keamanan" },
  { value: "business_manager", label: "Manajer usaha", summary: "Operasional lintas cabang" },
  { value: "branch_manager", label: "Kepala cabang", summary: "Operasional dan laporan cabang" },
  { value: "supervisor", label: "Supervisor", summary: "Persetujuan dan kendali shift" },
  { value: "cashier", label: "Kasir", summary: "POS, kas, pelanggan, dan struk sendiri" },
  { value: "warehouse", label: "Gudang", summary: "Stok, penerimaan, dan transfer" },
  { value: "purchasing", label: "Pembelian", summary: "Pemasok, PO, dan tagihan" },
  { value: "finance", label: "Keuangan", summary: "Akuntansi, utang, piutang, laporan" },
  { value: "service_staff", label: "Staf layanan", summary: "Jadwal dan pekerjaan jasa" },
  { value: "kitchen", label: "Dapur", summary: "Antrean dan status pesanan dapur" },
  { value: "waiter", label: "Pramusaji", summary: "Meja, pesanan, dan status dapur" },
  { value: "auditor", label: "Auditor", summary: "Laporan dan audit hanya-baca" },
];

export function roleLabel(role: Role): string {
  return roleCatalog.find((item) => item.value === role)?.label ?? role;
}

export type WorkspaceArea = "home" | "pos" | "products" | "reports" | "operations" | "approvals";

const roleAreas: Record<Role, readonly WorkspaceArea[]> = {
  owner: ["home", "pos", "products", "reports", "operations"],
  business_manager: ["home", "pos", "products", "reports", "operations"],
  branch_manager: ["home", "pos", "products", "reports", "operations"],
  supervisor: ["home", "pos", "products", "reports", "operations"],
  cashier: ["home", "pos", "operations"],
  warehouse: ["home", "products", "operations"],
  purchasing: ["home", "products", "reports", "operations"],
  finance: ["home", "reports", "operations"],
  service_staff: ["home", "pos", "operations"],
  kitchen: ["home", "operations"],
  waiter: ["home", "pos", "operations"],
  auditor: ["home", "reports", "operations"],
};

export function areasFor(role: Role): readonly WorkspaceArea[] {
  return roleAreas[role];
}

const moduleAccess: Partial<Record<Role, readonly string[]>> = {
  cashier: ["customer", "loyalty", "notification"],
  warehouse: ["goods_receipt", "stock_count", "stock_transfer", "stock_adjustment", "lot", "hardware"],
  purchasing: ["supplier", "purchase_order", "goods_receipt", "supplier_bill", "purchase_return", "payable", "price_list"],
  finance: ["supplier_bill", "payable", "receivable", "expense", "manual_journal", "fiscal_period", "asset", "tax", "notification"],
  service_staff: ["customer", "service", "appointment", "loyalty", "notification"],
  kitchen: ["kitchen_order", "recipe", "modifier", "lot", "notification"],
  waiter: ["customer", "dining_table", "kitchen_order", "loyalty", "notification"],
  auditor: ["notification"],
};

export function canAccessModule(role: Role, kind: string): boolean {
  if (["owner", "business_manager"].includes(role)) return true;
  if (["branch_manager", "supervisor"].includes(role))
    return !["fiscal_period", "tax", "staff", "device"].includes(kind);
  return (moduleAccess[role] ?? []).includes(kind);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return rolePermissions[role];
}

export function can(role: Role, permission: Permission): boolean {
  return rolePermissions[role].includes(permission as never);
}

export type BusinessModule =
  "retail" | "food_service" | "services" | "wholesale";

export interface BusinessProfile {
  id: string;
  tenantId: string;
  name: string;
  modules: readonly BusinessModule[];
  currency: "IDR";
  timezone: "Asia/Jakarta";
}

export const businessModules = [
  "retail",
  "food_service",
  "services",
  "wholesale",
] as const;

export function slugifyTenantName(value: string): string {
  const base = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base.length >= 2 ? base : "usaha";
}

export function normalizeBranchCode(value: string): string {
  const code = value
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 20);
  return code.length >= 2 ? code : "UTAMA";
}

export interface CartLine {
  productId: string;
  name: string;
  quantity: number;
  priceMinor: number;
  discountMinor?: number;
  taxRate?: number;
}

export interface CartTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  itemCount: number;
}

export function calculateCart(lines: readonly CartLine[]): CartTotals {
  return lines.reduce<CartTotals>(
    (totals, line) => {
      if (line.quantity <= 0 || line.priceMinor < 0)
        throw new Error("invalid_cart_line");
      const gross = Math.round(line.quantity * line.priceMinor);
      const discount = Math.min(gross, Math.max(0, line.discountMinor ?? 0));
      const taxable = gross - discount;
      const tax = Math.round((taxable * Math.max(0, line.taxRate ?? 0)) / 100);
      return {
        subtotalMinor: totals.subtotalMinor + gross,
        discountMinor: totals.discountMinor + discount,
        taxMinor: totals.taxMinor + tax,
        totalMinor: totals.totalMinor + taxable + tax,
        itemCount: totals.itemCount + line.quantity,
      };
    },
    {
      subtotalMinor: 0,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
      itemCount: 0,
    },
  );
}

export function formatRupiah(minor: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(minor);
}

export function nextReceiptNumber(
  branchCode: string,
  sequence: number,
  date = new Date(),
): string {
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${normalizeBranchCode(branchCode)}-${day}-${String(sequence).padStart(5, "0")}`;
}

export interface PlatformSettlementSplit {
  grossMinor: number;
  platformFeeMinor: number;
  reserveMinor: number;
  merchantNetMinor: number;
}

export function splitPlatformSettlement(input: {
  grossMinor: number;
  platformFeeBps: number;
  reserveBps: number;
}): PlatformSettlementSplit {
  const grossMinor = Math.round(input.grossMinor);
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0) throw new Error("invalid_gross_amount");
  if (!Number.isInteger(input.platformFeeBps) || !Number.isInteger(input.reserveBps) ||
      input.platformFeeBps < 0 || input.reserveBps < 0 || input.platformFeeBps + input.reserveBps > 9000) {
    throw new Error("invalid_wallet_policy");
  }
  const platformFeeMinor = Math.round(grossMinor * input.platformFeeBps / 10_000);
  const reserveMinor = Math.round(grossMinor * input.reserveBps / 10_000);
  return { grossMinor, platformFeeMinor, reserveMinor, merchantNetMinor: grossMinor - platformFeeMinor - reserveMinor };
}

export interface StockSignal {
  productId: string;
  name: string;
  stock: number;
  minimumStock: number;
  suggestedOrder: number;
}
export function lowStockSignals(
  products: readonly {
    id: string;
    name: string;
    stock: number;
    minimumStock: number;
  }[],
): StockSignal[] {
  return products
    .filter((item) => item.stock <= item.minimumStock)
    .map((item) => ({
      productId: item.id,
      name: item.name,
      stock: item.stock,
      minimumStock: item.minimumStock,
      suggestedOrder: Math.max(
        1,
        Math.ceil(item.minimumStock * 2 - item.stock),
      ),
    }));
}

export type NegativeStockPolicy = "blocked" | "approval" | "allowed";
export function evaluateStockSale(input: {
  available: number;
  requested: number;
  policy: NegativeStockPolicy;
  role: Role;
  approved?: boolean;
}): { allowed: boolean; requiresApproval: boolean; risk: boolean } {
  if (input.requested <= input.available)
    return { allowed: true, requiresApproval: false, risk: false };
  if (input.policy === "allowed")
    return { allowed: true, requiresApproval: false, risk: true };
  if (input.policy === "blocked")
    return { allowed: false, requiresApproval: false, risk: true };
  const privileged = input.role === "owner" || input.role === "supervisor";
  return {
    allowed: privileged && input.approved === true,
    requiresApproval: true,
    risk: true,
  };
}

export interface DailyDemand {
  date: string;
  quantity: number;
}
export interface ForecastResult {
  status: "insufficient_data" | "ready";
  dailyAverage: number;
  suggestedOrder: number;
  confidence: "low" | "medium";
  windowDays: number;
}

export interface StatisticalDemandResult {
  status: "insufficient_data" | "ready";
  movingAverage7: number;
  movingAverage30: number;
  exponentialForecast: number;
  peakWeekday: number | null;
  seasonalFactor: number;
  demandStdDev: number;
  reorderPoint: number;
  suggestedOrder: number;
  daysUntilStockout: number | null;
  windowDays: number;
}

export function analyzeDemand(input: {
  history: readonly DailyDemand[];
  stock: number;
  minimumStock: number;
  leadTimeDays: number;
  alpha?: number;
}): StatisticalDemandResult {
  const byDate = new Map(
    input.history.map((item) => [item.date, Math.max(0, Number(item.quantity) || 0)]),
  );
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) {
    return {
      status: "insufficient_data",
      movingAverage7: 0,
      movingAverage30: 0,
      exponentialForecast: 0,
      peakWeekday: null,
      seasonalFactor: 1,
      demandStdDev: 0,
      reorderPoint: Math.max(0, input.minimumStock),
      suggestedOrder: Math.max(0, Math.ceil(input.minimumStock - input.stock)),
      daysUntilStockout: null,
      windowDays: 0,
    };
  }
  const start = new Date(`${dates[0]}T00:00:00.000Z`);
  const end = new Date(`${dates.at(-1)}T00:00:00.000Z`);
  const series: { date: string; quantity: number; weekday: number }[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    series.push({ date, quantity: byDate.get(date) ?? 0, weekday: cursor.getUTCDay() });
  }
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const ma7 = average(series.slice(-7).map((item) => item.quantity));
  const ma30 = average(series.slice(-30).map((item) => item.quantity));
  const alpha = Math.max(0.05, Math.min(0.95, input.alpha ?? 0.35));
  let exponential = series[0]?.quantity ?? 0;
  for (const point of series.slice(1)) exponential = alpha * point.quantity + (1 - alpha) * exponential;
  const recent = series.slice(-30).map((item) => item.quantity);
  const variance = average(recent.map((value) => (value - ma30) ** 2));
  const stdDev = Math.sqrt(variance);
  const weekdayAverages = Array.from({ length: 7 }, (_, weekday) => {
    const values = series.filter((item) => item.weekday === weekday).map((item) => item.quantity);
    return { weekday, average: average(values) };
  });
  const peak = weekdayAverages.sort((a, b) => b.average - a.average)[0];
  const seasonalFactor = ma30 > 0 ? Math.max(0.5, Math.min(2, (peak?.average ?? ma30) / ma30)) : 1;
  const leadTime = Math.max(1, Math.round(input.leadTimeDays));
  const safetyStock = Math.max(input.minimumStock, 1.65 * stdDev * Math.sqrt(leadTime));
  const dailyDemand = Math.max(ma30, exponential);
  const reorderPoint = Math.ceil(dailyDemand * leadTime + safetyStock);
  return {
    status: series.length >= 14 ? "ready" : "insufficient_data",
    movingAverage7: ma7,
    movingAverage30: ma30,
    exponentialForecast: exponential,
    peakWeekday: peak?.average ? peak.weekday : null,
    seasonalFactor,
    demandStdDev: stdDev,
    reorderPoint,
    suggestedOrder: Math.max(0, Math.ceil(reorderPoint - input.stock)),
    daysUntilStockout: dailyDemand > 0 ? Math.max(0, input.stock / dailyDemand) : null,
    windowDays: series.length,
  };
}
export function forecastReorder(
  history: readonly DailyDemand[],
  stock: number,
  minimumStock: number,
  leadTimeDays: number,
): ForecastResult {
  const dates = new Set(history.map((x) => x.date));
  if (dates.size < 14)
    return {
      status: "insufficient_data",
      dailyAverage: 0,
      suggestedOrder: Math.max(0, minimumStock - stock),
      confidence: "low",
      windowDays: dates.size,
    };
  const recent = [...history]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);
  const average =
    recent.reduce((n, x) => n + Math.max(0, x.quantity), 0) /
    Math.max(1, recent.length);
  const safety = Math.max(minimumStock, average * 3);
  return {
    status: "ready",
    dailyAverage: average,
    suggestedOrder: Math.max(
      0,
      Math.ceil(average * Math.max(1, leadTimeDays) + safety - stock),
    ),
    confidence: dates.size >= 30 ? "medium" : "low",
    windowDays: dates.size,
  };
}

export interface AnomalySignal {
  kind: "negative_margin" | "high_refund" | "cash_variance" | "negative_stock" | "unusual_discount" | "possible_duplicate";
  severity: "medium" | "high";
  detail: string;
}
export function detectOperationalAnomalies(input: {
  salesMinor: number;
  costMinor: number;
  refundMinor: number;
  cashVarianceMinor: number;
  negativeStockCount: number;
  highDiscountCount?: number;
  possibleDuplicateGroups?: number;
}): AnomalySignal[] {
  const result: AnomalySignal[] = [];
  if (input.costMinor > input.salesMinor)
    result.push({
      kind: "negative_margin",
      severity: "high",
      detail: "HPP melebihi penjualan pada periode.",
    });
  if (input.salesMinor > 0 && input.refundMinor / input.salesMinor > 0.1)
    result.push({
      kind: "high_refund",
      severity: "high",
      detail: "Rasio retur melebihi 10%.",
    });
  if (Math.abs(input.cashVarianceMinor) > 0)
    result.push({
      kind: "cash_variance",
      severity: "medium",
      detail: "Kas aktual berbeda dari kas yang diharapkan.",
    });
  if (input.negativeStockCount > 0)
    result.push({
      kind: "negative_stock",
      severity: "high",
      detail: `${input.negativeStockCount} produk memiliki stok negatif.`,
    });
  if ((input.highDiscountCount ?? 0) > 0)
    result.push({
      kind: "unusual_discount",
      severity: "medium",
      detail: `${input.highDiscountCount} transaksi memiliki diskon di atas batas tinjauan.`,
    });
  if ((input.possibleDuplicateGroups ?? 0) > 0)
    result.push({
      kind: "possible_duplicate",
      severity: "medium",
      detail: `${input.possibleDuplicateGroups} kelompok transaksi memiliki waktu dan nominal serupa.`,
    });
  return result;
}

export interface PriceTier {
  minimumQuantity: number;
  priceMinor: number;
}

export function resolveTierPrice(
  basePriceMinor: number,
  quantity: number,
  tiers: readonly PriceTier[],
): number {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("invalid_quantity");
  if (!Number.isInteger(basePriceMinor) || basePriceMinor < 0)
    throw new Error("invalid_price");
  return [...tiers]
    .filter(
      (tier) =>
        tier.minimumQuantity > 0 &&
        Number.isInteger(tier.priceMinor) &&
        tier.priceMinor >= 0 &&
        quantity >= tier.minimumQuantity,
    )
    .sort((a, b) => b.minimumQuantity - a.minimumQuantity)[0]?.priceMinor ??
    basePriceMinor;
}

export function calculateTax(input: {
  amountMinor: number;
  rate: number;
  mode: "inclusive" | "exclusive";
}): { netMinor: number; taxMinor: number; grossMinor: number } {
  const amount = Math.round(input.amountMinor);
  if (amount < 0 || input.rate < 0 || input.rate > 100)
    throw new Error("invalid_tax_input");
  if (input.mode === "inclusive") {
    const net = Math.round(amount / (1 + input.rate / 100));
    return { netMinor: net, taxMinor: amount - net, grossMinor: amount };
  }
  const tax = Math.round((amount * input.rate) / 100);
  return { netMinor: amount, taxMinor: tax, grossMinor: amount + tax };
}

export function calculateCreditPayment(input: {
  totalMinor: number;
  paidNowMinor: number;
}): { paidNowMinor: number; outstandingMinor: number } {
  const totalMinor = Math.round(input.totalMinor);
  const paidNowMinor = Math.round(input.paidNowMinor);
  if (!Number.isFinite(totalMinor) || totalMinor <= 0)
    throw new Error("invalid_credit_total");
  if (!Number.isFinite(paidNowMinor) || paidNowMinor < 0 || paidNowMinor >= totalMinor)
    throw new Error("invalid_credit_payment");
  return { paidNowMinor, outstandingMinor: totalMinor - paidNowMinor };
}

export interface DepreciationPeriod {
  period: number;
  depreciationMinor: number;
  accumulatedMinor: number;
  bookValueMinor: number;
}

export function straightLineDepreciation(input: {
  costMinor: number;
  residualMinor: number;
  usefulLifeMonths: number;
}): DepreciationPeriod[] {
  const cost = Math.round(input.costMinor),
    residual = Math.round(input.residualMinor),
    months = Math.round(input.usefulLifeMonths);
  if (cost <= 0 || residual < 0 || residual >= cost || months <= 0)
    throw new Error("invalid_asset_policy");
  const depreciable = cost - residual;
  const base = Math.floor(depreciable / months);
  let accumulated = 0;
  return Array.from({ length: months }, (_, index) => {
    const depreciation =
      index === months - 1 ? depreciable - accumulated : base;
    accumulated += depreciation;
    return {
      period: index + 1,
      depreciationMinor: depreciation,
      accumulatedMinor: accumulated,
      bookValueMinor: cost - accumulated,
    };
  });
}

export type RfmSegment = "champion" | "loyal" | "promising" | "at_risk" | "hibernating";
export function classifyRfm(input: {
  recencyDays: number;
  frequency: number;
  monetaryMinor: number;
}): RfmSegment {
  if (input.recencyDays <= 30 && input.frequency >= 5 && input.monetaryMinor >= 1_000_000)
    return "champion";
  if (input.recencyDays <= 60 && input.frequency >= 3) return "loyal";
  if (input.recencyDays <= 30) return "promising";
  if (input.recencyDays <= 120 && input.frequency >= 2) return "at_risk";
  return "hibernating";
}
