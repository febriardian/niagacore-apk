import type { MutationEnvelope, Role } from "@niagacore/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/lib/supabase";
import { decodeProductImageBase64, MAX_PRODUCT_IMAGE_BYTES } from "@/lib/product-image";
import { mergeDashboardAnalytics, type DashboardAnalytics } from "@/lib/report-aggregation";
export { mergeDashboardAnalytics } from "@/lib/report-aggregation";
export type { DashboardAnalytics } from "@/lib/report-aggregation";

export type RemoteStore = SupabaseClient;

export function useRemoteStore(): RemoteStore {
  // Authentication already blocks operational screens when the production
  // backend is absent. Avoid throwing while the root provider is mounting so
  // a configuration mistake is shown as an auth error instead of a force close.
  return supabase as RemoteStore;
}

function check(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface LocalTenantContext {
  tenantId: string;
  businessId: string;
  branchId: string;
  deviceId: string;
  userId: string;
  role: Role;
}

export async function saveTenantContext(_db: RemoteStore, _context: LocalTenantContext): Promise<void> {}
export async function clearTenantContext(_db: RemoteStore): Promise<void> {}
export async function purgeLocalTenantData(_db: RemoteStore): Promise<void> {}
export async function pendingMutationCount(db: RemoteStore, tenantId: string, branchId: string): Promise<number> {
  const [{ count: failures, error: failureError }, { count: conflicts, error: conflictError }] = await Promise.all([
    db.from("sync_failure_events").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("branch_id", branchId).eq("status", "requires_review"),
    db.from("sync_conflict_reviews").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("branch_id", branchId).eq("status", "requires_review"),
  ]);
  check(failureError); check(conflictError); return (failures ?? 0) + (conflicts ?? 0);
}

export interface SyncFailure { id: string; mutationId: string; errorCode: string; occurredAt: string; resolvedAt: string | null; }
export interface SyncConflictReview { id: string; mutationId: string; aggregateType: string; aggregateId: string; errorCode: string; occurredAt: string; resolvedAt: string | null; }
export async function listSyncFailures(db: RemoteStore, tenantId: string, branchId: string): Promise<SyncFailure[]> {
  const { data, error } = await db.from("sync_failure_events").select("id,mutation_id,error_code,created_at,resolved_at")
    .eq("tenant_id", tenantId).eq("branch_id", branchId).eq("status", "requires_review").order("created_at", { ascending: false });
  check(error); return (data ?? []).map((row) => ({ id: row.id, mutationId: row.mutation_id, errorCode: row.error_code, occurredAt: row.created_at, resolvedAt: row.resolved_at }));
}
export async function listSyncConflicts(db: RemoteStore, tenantId: string, branchId: string): Promise<SyncConflictReview[]> {
  const { data, error } = await db.from("sync_conflict_reviews").select("id,mutation_id,aggregate_type,aggregate_id,error_code,created_at,resolved_at")
    .eq("tenant_id", tenantId).eq("branch_id", branchId).eq("status", "requires_review").order("created_at", { ascending: false });
  check(error); return (data ?? []).map((row) => ({ id: row.id, mutationId: row.mutation_id, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, errorCode: row.error_code, occurredAt: row.created_at, resolvedAt: row.resolved_at }));
}
export async function resolveSyncFailure(db: RemoteStore, id: string): Promise<void> { const { error } = await db.rpc("resolve_sync_review", { target_kind: "failure", target_id: id }); check(error); }
export async function resolveSyncConflictKeepingServer(db: RemoteStore, id: string): Promise<void> { const { error } = await db.rpc("resolve_sync_review", { target_kind: "conflict", target_id: id }); check(error); }

async function applyMutation(db: RemoteStore, context: Pick<LocalTenantContext, "tenantId" | "branchId" | "deviceId">, mutation: MutationEnvelope): Promise<void> {
  const { data, error } = await db.functions.invoke("sync", {
    body: { deviceId: context.deviceId, tenantId: context.tenantId, branchId: context.branchId, cursor: 0, mutations: [mutation] },
  });
  check(error);
  const receipt = Array.isArray(data?.receipts)
    ? data.receipts.find((item: { mutationId?: string }) => item.mutationId === mutation.mutationId) ?? data.receipts[0]
    : null;
  if (receipt?.status && !["accepted", "duplicate"].includes(receipt.status)) throw new Error(receipt.errorCode ?? "server_rejected_mutation");
}

export interface LocalProduct {
  id: string; sku: string; barcode: string | null; name: string; category: string;
  priceMinor: number; costMinor: number; stock: number; minimumStock: number; unit: string;
  taxRate: number; productType: "goods" | "service" | "recipe" | "bundle";
  description: string | null; imagePath: string | null; imageUri: string | null; trackStock: boolean; allowNegative: boolean;
  metadata: Record<string, unknown>; version: number;
}
export interface SaveLocalProductInput extends LocalProduct { context: LocalTenantContext; mutation: MutationEnvelope; }

export async function listLocalProducts(db: RemoteStore, tenantId: string, branchId: string): Promise<LocalProduct[]> {
  const { data: branch, error: branchError } = await db.from("branches").select("business_id").eq("tenant_id", tenantId).eq("id", branchId).single();
  check(branchError);
  if (!branch) throw new Error("branch_not_found");
  const [{ data, error }, { data: movements, error: movementError }] = await Promise.all([
    db.from("products").select("*").eq("tenant_id", tenantId).eq("business_id", branch.business_id).eq("active", true).order("name"),
    db.from("inventory_movements").select("product_id,quantity").eq("tenant_id", tenantId).eq("branch_id", branchId),
  ]);
  check(error); check(movementError);
  const stockByProduct = new Map<string, number>();
  for (const movement of movements ?? []) stockByProduct.set(movement.product_id, (stockByProduct.get(movement.product_id) ?? 0) + number(movement.quantity));
  return (data ?? []).map((row) => ({
    ...(() => { const metadata = object(row.metadata); return {
    id: row.id, sku: row.sku, barcode: row.barcode ?? null, name: row.name, category: row.category ?? "Umum",
    priceMinor: number(row.price_minor), costMinor: number(row.cost_minor), stock: stockByProduct.get(row.id) ?? 0, minimumStock: number(metadata.minimumStock),
    unit: row.unit ?? "pcs", taxRate: number(row.tax_rate), productType: row.product_type ?? "goods",
    description: row.description ?? null,
    imagePath: row.image_path ?? null,
    imageUri: row.image_path ? (String(row.image_path).startsWith("http") ? row.image_path : `${db.storage.from("product-images").getPublicUrl(row.image_path).data.publicUrl}?v=${encodeURIComponent(row.updated_at??row.version??1)}`) : null,
    trackStock: row.track_stock !== false,
    allowNegative: row.allow_negative === true, metadata, version: number(row.version),
    }; })(),
  }));
}

export async function saveLocalProduct(db: RemoteStore, input: SaveLocalProductInput): Promise<void> {
  await applyMutation(db, input.context, { ...input.mutation, payload: { ...object(input.mutation.payload), openingStock: input.stock } });
}
export async function uploadProductImage(db:RemoteStore,context:Pick<LocalTenantContext,"tenantId"|"businessId">,productId:string,asset:{base64?:string|null;fileSize?:number|null;mimeType?:string|null}):Promise<{path:string;publicUrl:string}> {
  if((asset.fileSize??0)>MAX_PRODUCT_IMAGE_BYTES) throw new Error("product_image_too_large");
  if(!asset.base64) throw new Error("product_image_read_failed");
  const body=decodeProductImageBase64(asset.base64);
  if(body.byteLength>MAX_PRODUCT_IMAGE_BYTES) throw new Error("product_image_too_large");
  const path=`${context.tenantId}/${context.businessId}/${productId}`;
  const {error}=await db.storage.from("product-images").upload(path,body,{contentType:asset.mimeType??"image/jpeg",upsert:true});
  check(error);
  return {path,publicUrl:db.storage.from("product-images").getPublicUrl(path).data.publicUrl};
}
export async function archiveProduct(db: RemoteStore, _productId: string, mutation: MutationEnvelope): Promise<void> {
  await applyMutation(db, mutation, mutation);
}
export async function adjustStock(db: RemoteStore, context: LocalTenantContext, input: { id: string; productId: string; quantity: number; reason: string; mutation: MutationEnvelope }): Promise<void> {
  await applyMutation(db, context, input.mutation);
}

export type RecordKind = "customer" | "expense" | "supplier" | "purchase_order" | "goods_receipt" | "supplier_bill" | "purchase_return" | "payable" | "receivable" | "stock_count" | "stock_transfer" | "stock_adjustment" | "price_list" | "bundle" | "recipe" | "modifier" | "lot" | "customer_segment" | "loyalty" | "service" | "appointment" | "dining_table" | "kitchen_order" | "asset" | "manual_journal" | "fiscal_period" | "tax" | "staff" | "device" | "hardware" | "notification";
export interface BusinessRecord { id: string; kind: RecordKind; code: string | null; title: string; subtitle: string | null; status: string; amountMinor: number; quantity: number; dueAt: string | null; metadata: Record<string, unknown>; active: boolean; version: number; createdAt: string; updatedAt: string; }
export interface SaveBusinessRecordInput { id: string; kind: RecordKind; code?: string | null; title: string; subtitle?: string | null; status?: string; amountMinor?: number; quantity?: number; dueAt?: string | null; metadata?: Record<string, unknown>; active?: boolean; version?: number; context: LocalTenantContext; mutation: MutationEnvelope; }

export async function listBusinessRecords(db: RemoteStore, context: Pick<LocalTenantContext, "tenantId" | "branchId">, kind: RecordKind, includeArchived = false): Promise<BusinessRecord[]> {
  let query = db.from("business_records").select("*").eq("tenant_id", context.tenantId).eq("branch_id", context.branchId).eq("kind", kind).order("updated_at", { ascending: false });
  if (!includeArchived) query = query.eq("active", true);
  const { data, error } = await query; check(error);
  return (data ?? []).map((row) => ({ id: row.id, kind: row.kind, code: row.code, title: row.title, subtitle: row.subtitle,
    status: row.status, amountMinor: number(row.amount_minor), quantity: number(row.quantity), dueAt: row.due_at,
    metadata: object(row.metadata ?? row.metadata_json), active: row.active !== false, version: number(row.version),
    createdAt: row.created_at, updatedAt: row.updated_at }));
}
export async function saveBusinessRecord(db: RemoteStore, input: SaveBusinessRecordInput): Promise<void> { await applyMutation(db, input.context, input.mutation); }
export async function archiveBusinessRecord(db: RemoteStore, _recordId: string, mutation: MutationEnvelope): Promise<void> { await applyMutation(db, mutation, mutation); }
export async function transitionBusinessRecord(db: RemoteStore, input: { record: BusinessRecord; toStatus: string; context: LocalTenantContext; mutation: MutationEnvelope }): Promise<void> { await applyMutation(db, input.context, input.mutation); }

export interface ShiftSummary { id: string; status: "open" | "closed"; openingMinor: number; expectedMinor: number | null; closingMinor: number | null; openedAt: string; closedAt: string | null; }
export async function getActiveShift(db: RemoteStore, context: LocalTenantContext): Promise<ShiftSummary | null> {
  const { data, error } = await db.from("shifts").select("*").eq("tenant_id", context.tenantId).eq("branch_id", context.branchId).eq("device_id",context.deviceId).eq("user_id", context.userId).eq("status", "open").order("opened_at", { ascending: false }).limit(1).maybeSingle();
  check(error); return data ? { id: data.id, status: data.status, openingMinor: number(data.opening_minor), expectedMinor: data.expected_minor == null ? null : number(data.expected_minor), closingMinor: data.closing_minor == null ? null : number(data.closing_minor), openedAt: data.opened_at, closedAt: data.closed_at } : null;
}
export async function openShift(db: RemoteStore, context: LocalTenantContext, input: { id: string; openingMinor: number; mutation: MutationEnvelope }): Promise<void> { await applyMutation(db, context, input.mutation); }
export async function addCashMovement(db: RemoteStore, context: LocalTenantContext, input: { id: string; shiftId: string; direction: "in" | "out"; category: string; amountMinor: number; note?: string; mutation: MutationEnvelope }): Promise<void> { await applyMutation(db, context, input.mutation); }
export async function closeShift(db: RemoteStore, context: LocalTenantContext, input: { shiftId: string; closingMinor: number; reason?: string; mutation: MutationEnvelope }): Promise<number> {
  const shift = await getActiveShift(db, context); if (!shift) throw new Error("shift_not_open");
  const { data: payments, error: paymentError } = await db.from("payments").select("amount_minor,metadata,sales!inner(branch_id,shift_id)").eq("tenant_id", context.tenantId).eq("method", "cash").eq("sales.branch_id", context.branchId).gte("paid_at", shift.openedAt); check(paymentError);
  const { data: cash, error: cashError } = await db.from("cash_movements").select("direction,amount_minor").eq("shift_id", shift.id); check(cashError);
  const shiftPayments=(payments??[]).filter((row)=>{const sale=Array.isArray(row.sales)?row.sales[0]:row.sales;return sale?.shift_id===shift.id||String(object(row.metadata).shiftId??"")===shift.id});
  const expected = shift.openingMinor + shiftPayments.reduce((sum, row) => sum + number(row.amount_minor), 0) + (cash ?? []).reduce((sum, row) => sum + (row.direction === "in" ? number(row.amount_minor) : -number(row.amount_minor)), 0);
  const variance = input.closingMinor - expected; if (variance && !input.reason?.trim()) throw new Error("variance_reason_required");
  await applyMutation(db, context, input.mutation); return variance;
}

export interface LocalSaleLineInput { productId: string; name: string; quantity: number; priceMinor: number; costMinor: number; discountMinor: number; taxMinor: number; totalMinor: number; }
export interface CommitLocalSaleInput { id: string; receiptNumber: string; context: LocalTenantContext; lines: LocalSaleLineInput[]; subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number; customerId?: string | null; paymentMethod: "cash" | "qris"; shiftId?: string | null; mutation: MutationEnvelope; }
export async function commitLocalSale(db: RemoteStore, input: CommitLocalSaleInput): Promise<void> { await applyMutation(db, input.context, input.mutation); }

export interface CreditSaleResult {
  saleId: string;
  receivableId: string;
  receiptNumber: string;
  totalMinor: number;
  paidNowMinor: number;
  outstandingMinor: number;
}
export async function createCreditSale(db: RemoteStore, input: {
  id: string;
  receiptNumber: string;
  context: LocalTenantContext;
  customerId: string;
  shiftId: string;
  lines: { productId: string; quantity: number; discountMinor: number }[];
  paidNowMinor: number;
  dueAt?: string | null;
}): Promise<CreditSaleResult> {
  const { data, error } = await db.rpc("create_credit_sale", {
    target_sale_id: input.id,
    target_branch_id: input.context.branchId,
    client_device_id: input.context.deviceId,
    target_shift_id: input.shiftId,
    target_customer_id: input.customerId,
    target_receipt_number: input.receiptNumber,
    requested_lines: input.lines,
    paid_now_minor: input.paidNowMinor,
    target_due_at: input.dueAt || null,
  });
  check(error);
  const value = object(data);
  return {
    saleId: String(value.saleId),
    receivableId: String(value.receivableId),
    receiptNumber: String(value.receiptNumber),
    totalMinor: number(value.totalMinor),
    paidNowMinor: number(value.paidNowMinor),
    outstandingMinor: number(value.outstandingMinor),
  };
}

export interface CustomerReceivable {
  id: string;
  saleId: string;
  customerId: string;
  customerName: string;
  receiptNumber: string;
  originalMinor: number;
  settledMinor: number;
  outstandingMinor: number;
  dueAt: string | null;
  status: string;
}
export interface ReceivablePaymentHistory {
  id: string;
  amountMinor: number;
  method: string;
  paidAt: string;
  kind: "initial" | "installment";
}
export async function listCustomerReceivablePayments(db: RemoteStore, tenantId: string, saleId: string): Promise<ReceivablePaymentHistory[]> {
  const {data,error}=await db.from("payments").select("id,amount_minor,method,paid_at,metadata").eq("tenant_id",tenantId).eq("sale_id",saleId).not("paid_at","is",null).order("paid_at",{ascending:true});
  check(error);
  return (data??[]).map((row)=>({id:row.id,amountMinor:number(row.amount_minor),method:String(row.method),paidAt:String(row.paid_at),kind:object(row.metadata).kind==="initial_credit_payment"?"initial":"installment"}));
}
export async function listCustomerReceivables(db: RemoteStore, context: Pick<LocalTenantContext, "tenantId" | "branchId">): Promise<CustomerReceivable[]> {
  const { data: documents, error } = await db.from("subledger_documents").select("id,partner_id,original_minor,settled_minor,due_at,status").eq("tenant_id", context.tenantId).eq("branch_id", context.branchId).eq("document_type", "receivable").order("due_at", { ascending: true, nullsFirst: false });
  check(error);
  const openDocuments = (documents ?? []).filter((row) => number(row.original_minor) > number(row.settled_minor));
  if (!openDocuments.length) return [];
  const ids = openDocuments.map((row) => row.id);
  const customerIds = [...new Set(openDocuments.map((row) => row.partner_id).filter(Boolean))];
  const [{ data: records, error: recordError }, customerResult] = await Promise.all([
    db.from("business_records").select("id,code,title,metadata").in("id", ids),
    customerIds.length ? db.from("customers").select("id,name").in("id", customerIds) : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
  ]);
  check(recordError); check(customerResult.error);
  const customers = customerResult.data;
  const recordById = new Map((records ?? []).map((row) => [row.id, row]));
  const customerById = new Map((customers ?? []).map((row) => [row.id, row.name]));
  return openDocuments.map((row) => {
    const record = recordById.get(row.id);
    const metadata = object(record?.metadata);
    const originalMinor = number(row.original_minor), settledMinor = number(row.settled_minor);
    return {
      id: row.id,
      saleId: String(metadata.saleId ?? ""),
      customerId: String(row.partner_id ?? ""),
      customerName: customerById.get(row.partner_id) ?? record?.title ?? "Pelanggan",
      receiptNumber: String(metadata.receiptNumber ?? record?.code ?? "-"),
      originalMinor,
      settledMinor,
      outstandingMinor: originalMinor - settledMinor,
      dueAt: row.due_at,
      status: row.status,
    };
  });
}

export async function settleCustomerReceivable(db: RemoteStore, input: {
  paymentId: string;
  receivableId: string;
  amountMinor: number;
  shiftId: string;
  context: LocalTenantContext;
}): Promise<{ paidMinor: number; outstandingMinor: number; status: string }> {
  const { data, error } = await db.rpc("settle_customer_receivable", {
    target_receivable_id: input.receivableId,
    target_payment_id: input.paymentId,
    target_shift_id: input.shiftId,
    amount_minor: input.amountMinor,
  });
  check(error);
  const value = object(data);
  return { paidMinor: number(value.paidMinor), outstandingMinor: number(value.outstandingMinor), status: String(value.status) };
}

export type SalePaymentStatus = "unpaid" | "partial" | "paid";
export interface SaleHistoryItem { id: string; branchId: string; branchName: string | null; receiptNumber: string; totalMinor: number; paidMinor: number; outstandingMinor: number; paymentMethod: string; status: string; paymentStatus: SalePaymentStatus; occurredAt: string; }
export function salePaymentStatusLabel(sale: Pick<SaleHistoryItem,"paymentMethod"|"paymentStatus"|"status">): string {
  if (sale.paymentMethod !== "credit") {
    if (sale.status === "void") return "Kedaluwarsa";
    if (sale.status === "refunded") return "Dikembalikan";
    return sale.paymentStatus === "paid" ? "Dibayar" : "Menunggu pembayaran";
  }
  if (sale.paymentStatus === "unpaid") return "Belum dibayar";
  if (sale.paymentStatus === "partial") return "Dibayar sebagian";
  return "Lunas";
}
export type TransactionHistoryDays = 1 | 7 | 30 | 90 | 365 | 0;
function jakartaDateKey(value: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof value === "string" ? new Date(value) : value);
}
function dateParts(key: string): [number, number, number] {
  const parts = key.split("-");
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}
function jakartaStartIso(days: number): string {
  const todayKey = jakartaDateKey(new Date());
  const [year, month, day] = dateParts(todayKey);
  const startUtc = new Date(Date.UTC(year, month - 1, day - (days - 1), -7, 0, 0));
  return startUtc.toISOString();
}
function since(days?: TransactionHistoryDays): string | null { return days ? jakartaStartIso(days) : null; }
export async function listSales(db: RemoteStore, tenantId: string, branchId: string, limit = 100, days?: TransactionHistoryDays, cashierId?: string): Promise<SaleHistoryItem[]> {
  let query = db.from("sales").select("id,branch_id,receipt_number,total_minor,paid_minor,payment_method,status,occurred_at,branches(name)").eq("tenant_id", tenantId).eq("branch_id", branchId).order("occurred_at", { ascending: false }).limit(limit);
  if (cashierId) query = query.eq("cashier_id", cashierId);
  const start = since(days); if (start) query = query.gte("occurred_at", start);
  const { data, error } = await query; check(error); return (data ?? []).map((row) => { const branch=Array.isArray(row.branches)?row.branches[0]:row.branches,totalMinor=number(row.total_minor),paidMinor=number(row.paid_minor); return ({ id: row.id, branchId: row.branch_id, branchName: branch?.name ?? null, receiptNumber: row.receipt_number, totalMinor, paidMinor, outstandingMinor:Math.max(0,totalMinor-paidMinor), paymentMethod: row.payment_method, status: row.status, paymentStatus:(paidMinor<=0?"unpaid":paidMinor<totalMinor?"partial":"paid") as SalePaymentStatus, occurredAt: row.occurred_at }); });
}
export interface TransactionHistoryAnalytics { totalMinor: number; transactionCount: number; averageTicketMinor: number; refundedMinor: number; dailySales: { label: string; amountMinor: number; transactions: number }[]; paymentMix: { method: string; amountMinor: number; transactions: number }[]; }
function transactionHistoryAnalytics(rows: SaleHistoryItem[], days: TransactionHistoryDays): TransactionHistoryAnalytics {
  const paid = rows.filter((r) => r.status === "paid");
  const totalMinor = paid.reduce((sum, row) => sum + row.totalMinor, 0), transactionCount = paid.length;
  const daily = new Map<string, { amountMinor: number; transactions: number }>(); const mix = new Map<string, { amountMinor: number; transactions: number }>();
  for (const row of paid) { const label = jakartaDateKey(row.occurredAt), day = daily.get(label) ?? { amountMinor: 0, transactions: 0 }; day.amountMinor += row.totalMinor; day.transactions++; daily.set(label, day); if(row.paymentMethod==="credit"){if(row.paidMinor>0){const received=mix.get("cash")??{amountMinor:0,transactions:0};received.amountMinor+=row.paidMinor;received.transactions++;mix.set("cash",received)}if(row.outstandingMinor>0){const outstanding=mix.get("receivable")??{amountMinor:0,transactions:0};outstanding.amountMinor+=row.outstandingMinor;outstanding.transactions++;mix.set("receivable",outstanding)}}else{const method=mix.get(row.paymentMethod)??{amountMinor:0,transactions:0};method.amountMinor+=row.totalMinor;method.transactions++;mix.set(row.paymentMethod,method)} }
  const countDays = days || Math.max(daily.size, 1); const todayKey = jakartaDateKey(new Date()); const [year, month, day] = dateParts(todayKey);
  const dailySales = days===0
    ? [...daily].sort(([a],[b])=>a.localeCompare(b)).map(([label,value])=>({label,...value}))
    : Array.from({ length: countDays }, (_, index) => { const cursor = new Date(Date.UTC(year, month - 1, day - (countDays - 1 - index), 12)); const label = cursor.toISOString().slice(0,10); return { label, ...(daily.get(label) ?? { amountMinor: 0, transactions: 0 }) }; });
  return { totalMinor, transactionCount, averageTicketMinor: transactionCount ? Math.round(totalMinor / transactionCount) : 0, refundedMinor: rows.filter((r) => r.status === "refunded").reduce((sum, row) => sum + row.totalMinor, 0), dailySales, paymentMix: [...mix].map(([method, value]) => ({ method, ...value })) };
}
export async function getTransactionHistoryAnalytics(db: RemoteStore, tenantId: string, branchId: string, days: TransactionHistoryDays): Promise<TransactionHistoryAnalytics> {
  return transactionHistoryAnalytics(await listSales(db, tenantId, branchId, 10000, days), days);
}
export type SalesHistoryContext = Pick<LocalTenantContext, "tenantId" | "branchId" | "role" | "userId"> & { branches?: { id:string }[] };
export async function expireStaleQrisPayments(db: RemoteStore, context: Pick<SalesHistoryContext,"tenantId"|"branchId">): Promise<number> {
  const {data,error}=await db.rpc("expire_stale_qris_payments",{target_tenant_id:context.tenantId,target_branch_id:context.branchId});
  check(error);return number(data);
}
function historyBranchIds(context: SalesHistoryContext): string[] {
  return [context.branchId];
}
export async function listSalesForContext(db: RemoteStore, context: SalesHistoryContext, limit = 100, days?: TransactionHistoryDays): Promise<SaleHistoryItem[]> {
  const rows=(await Promise.all(historyBranchIds(context).map((branchId)=>listSales(db,context.tenantId,branchId,limit,days)))).flat();
  return rows.sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)).slice(0,limit);
}
export async function getTransactionHistoryAnalyticsForContext(db: RemoteStore, context: SalesHistoryContext, days: TransactionHistoryDays): Promise<TransactionHistoryAnalytics> {
  return transactionHistoryAnalytics(await listSalesForContext(db,context,10000,days),days);
}
export interface SaleReceiptDetail extends SaleHistoryItem { subtotalMinor: number; discountMinor: number; taxMinor: number; customerName: string | null; lines: { name: string; quantity: number; totalMinor: number }[]; }
export async function getSaleReceipt(db: RemoteStore, context: SalesHistoryContext, branchId: string, saleId: string): Promise<SaleReceiptDetail | null> {
  let query=db.from("sales").select("*,customers(name)").eq("id", saleId).eq("tenant_id", context.tenantId).eq("branch_id", branchId);
  const { data: sale, error } = await query.maybeSingle(); check(error); if (!sale) return null;
  const { data: lines, error: lineError } = await db.from("sale_items").select("name,quantity,total_minor").eq("sale_id", saleId); check(lineError);
  const customer = Array.isArray(sale.customers) ? sale.customers[0] : sale.customers;
  const totalMinor=number(sale.total_minor),paidMinor=number(sale.paid_minor);
  return { id: sale.id, branchId: sale.branch_id, branchName: null, receiptNumber: sale.receipt_number, subtotalMinor: number(sale.subtotal_minor), discountMinor: number(sale.discount_minor), taxMinor: number(sale.tax_minor), totalMinor, paidMinor, outstandingMinor:Math.max(0,totalMinor-paidMinor), paymentMethod: sale.payment_method, status: sale.status, paymentStatus:(paidMinor<=0?"unpaid":paidMinor<totalMinor?"partial":"paid") as SalePaymentStatus, occurredAt: sale.occurred_at, customerName: customer?.name ?? null, lines: (lines ?? []).map((line) => ({ name: line.name, quantity: number(line.quantity), totalMinor: number(line.total_minor) })) };
}
export async function requestRefund(db: RemoteStore, context: LocalTenantContext, input: { id: string; saleId: string; amountMinor: number; reason: string; stockDisposition: "restock" | "damaged"; approved: boolean; mutation: MutationEnvelope }): Promise<void> { await applyMutation(db, context, input.mutation); }

export interface PendingApproval { id: string; kind: string; resourceId: string | null; reason: string; requestedBy: string; createdAt: string; payload: Record<string, unknown>; }
export async function listPendingApprovals(db: RemoteStore, context: Pick<LocalTenantContext, "tenantId" | "branchId">): Promise<PendingApproval[]> {
  const [direct, refunds] = await Promise.all([
    db.from("approval_requests").select("*").eq("tenant_id", context.tenantId).eq("branch_id", context.branchId).eq("status", "pending"),
    db.from("refunds").select("*").eq("tenant_id", context.tenantId).eq("branch_id", context.branchId).eq("status", "pending"),
  ]); check(direct.error); check(refunds.error);
  return [...(direct.data ?? []).map((row) => ({ id: row.id, kind: row.kind, resourceId: row.resource_id, reason: row.reason, requestedBy: row.requested_by, createdAt: row.created_at, payload: object(row.payload ?? row.payload_json) })), ...(refunds.data ?? []).map((row) => ({ id: row.id, kind: "refund", resourceId: row.sale_id, reason: row.reason, requestedBy: row.requested_by, createdAt: row.occurred_at, payload: { amountMinor: number(row.amount_minor), stockDisposition: row.stock_disposition } }))].sort((a,b) => a.createdAt.localeCompare(b.createdAt));
}
export async function resolveLocalApproval(_db: RemoteStore, _context: LocalTenantContext, _approval: PendingApproval, _decision: "approved" | "rejected"): Promise<void> {}

export interface AccountingSettings { taxProfile: "non_pkp" | "pkp"; ppnEnabled: boolean; ppnRate: number; inventoryCosting: "moving_average" | "fifo"; roundingPolicy: string; fiscalYearStart: number; negativeStockPolicy: "blocked" | "approval" | "allowed"; cloudAiEnabled: boolean; }
const defaultAccounting: AccountingSettings = { taxProfile: "non_pkp", ppnEnabled: false, ppnRate: 11, inventoryCosting: "moving_average", roundingPolicy: "nearest", fiscalYearStart: 1, negativeStockPolicy: "blocked", cloudAiEnabled: true };
export async function getAccountingSettings(db: RemoteStore, context: Pick<LocalTenantContext, "tenantId" | "businessId">): Promise<AccountingSettings> {
  const { data, error } = await db.from("accounting_settings").select("*").eq("tenant_id", context.tenantId).eq("business_id", context.businessId).maybeSingle(); check(error); if (!data) return defaultAccounting;
  return { taxProfile: data.tax_profile, ppnEnabled: data.ppn_enabled, ppnRate: number(data.ppn_rate), inventoryCosting: data.inventory_costing, roundingPolicy: data.rounding_policy, fiscalYearStart: number(data.fiscal_year_start), negativeStockPolicy: data.negative_stock_policy, cloudAiEnabled: data.cloud_ai_enabled !== false };
}
export async function saveAccountingSettings(db: RemoteStore, context: Pick<LocalTenantContext, "tenantId" | "businessId">, settings: AccountingSettings, mutation?: MutationEnvelope): Promise<void> {
  if (mutation && "branchId" in context && "deviceId" in context) return applyMutation(db, context as LocalTenantContext, mutation);
  const { error } = await db.from("accounting_settings").upsert({ tenant_id: context.tenantId, business_id: context.businessId, tax_profile: settings.taxProfile, ppn_enabled: settings.ppnEnabled, ppn_rate: settings.ppnRate, inventory_costing: settings.inventoryCosting, rounding_policy: settings.roundingPolicy, fiscal_year_start: settings.fiscalYearStart, negative_stock_policy: settings.negativeStockPolicy, cloud_ai_enabled: settings.cloudAiEnabled }); check(error);
}
export async function seedAccountingDefaults(db: RemoteStore, context: Pick<LocalTenantContext, "tenantId" | "businessId">): Promise<void> { const current = await getAccountingSettings(db, context); if (!current) await saveAccountingSettings(db, context, defaultAccounting); }

type ReportingContext = Pick<LocalTenantContext, "tenantId" | "branchId" | "businessId" | "role"> & { branches?: { id:string }[] };
export type ReportingScope="branch"|"business";
async function getBranchDashboard(db:RemoteStore,branchId:string,days:number):Promise<DashboardAnalytics>{
  const { data, error } = await db.rpc("get_branch_dashboard", { target_branch_id: branchId, period_days: days });
  check(error);
  return dashboardFromRpc(data,days);
}
function dashboardFromRpc(data:unknown,days:number):DashboardAnalytics{
  const value = object(data);
  const dailySales = Array.isArray(value.dailySales) ? value.dailySales : [];
  const topProducts = Array.isArray(value.topProducts) ? value.topProducts : [];
  const paymentMix = Array.isArray(value.paymentMix) ? value.paymentMix : [];
  return {dailySales: dailySales.map((item) => { const row=object(item); return { label:String(row.label??""), amountMinor:number(row.amountMinor), transactions:number(row.transactions) }; }),topProducts: topProducts.map((item) => { const row=object(item); return { name:String(row.name??""), quantity:number(row.quantity), revenueMinor:number(row.revenueMinor) }; }),paymentMix: paymentMix.map((item) => { const row=object(item); return { method:String(row.method??"unknown"), amountMinor:number(row.amountMinor) }; }),grossSalesMinor:number(value.grossSalesMinor), costMinor:number(value.costMinor), expenseMinor:number(value.expenseMinor),profitMinor:number(value.profitMinor), receivableMinor:number(value.receivableMinor), payableMinor:number(value.payableMinor),lowStockCount:number(value.lowStockCount), previousGrossSalesMinor:number(value.previousGrossSalesMinor),transactionCount:number(value.transactionCount), averageTicketMinor:number(value.averageTicketMinor), periodDays:days};
}
function reportBranchIds(context:ReportingContext,scope:ReportingScope):string[]{return scope==="business"&&["owner","business_manager"].includes(context.role)?[...new Set(context.branches?.map(branch=>branch.id)??[context.branchId])]:[context.branchId]}
export async function getDashboardAnalytics(db: RemoteStore, context: ReportingContext, requestedDays = 7,scope:ReportingScope="branch"): Promise<DashboardAnalytics> {
  const days = [7,30,90].includes(requestedDays) ? requestedDays as 7|30|90 : 7;
  const rows=await Promise.all(reportBranchIds(context,scope).map(branchId=>getBranchDashboard(db,branchId,days)));
  return rows.length===1?rows[0]!:mergeDashboardAnalytics(rows,days);
}
export async function getCashierDashboardAnalytics(db: RemoteStore, context: SalesHistoryContext, requestedDays = 7): Promise<DashboardAnalytics> {
  const days=[7,30,90].includes(requestedDays)?requestedDays as 7|30|90:7;
  const {data,error}=await db.rpc("get_cashier_dashboard",{target_branch_id:context.branchId,period_days:days});
  if(error){
    const missingRpc=error.code==="PGRST202"||/get_cashier_dashboard[\s\S]*schema cache/i.test(error.message??"");
    if(missingRpc)return getCashierDashboardFallback(db,context,days);
    check(error);
  }
  return dashboardFromRpc(data,days);
}
async function getCashierDashboardFallback(db:RemoteStore,context:SalesHistoryContext,days:7|30|90):Promise<DashboardAnalytics>{
  const [periodSales,allSales,payments]=await Promise.all([
    listSales(db,context.tenantId,context.branchId,10000,days),
    listSales(db,context.tenantId,context.branchId,10000),
    db.from("payments")
      .select("method,amount_minor,paid_at,sales!inner(branch_id,status)")
      .eq("tenant_id",context.tenantId)
      .eq("sales.branch_id",context.branchId)
      .eq("sales.status","paid")
      .gte("paid_at",jakartaStartIso(days))
      .limit(10000),
  ]);
  check(payments.error);
  const value=transactionHistoryAnalytics(periodSales,days);
  const received=new Map<string,number>();
  for(const row of payments.data??[]){const method=String(row.method??"unknown");received.set(method,(received.get(method)??0)+number(row.amount_minor))}
  const receivableMinor=allSales.filter((sale)=>sale.status==="paid"&&sale.paymentMethod==="credit").reduce((sum,sale)=>sum+sale.outstandingMinor,0);
  return {dailySales:value.dailySales,topProducts:[],paymentMix:[...received].map(([method,amountMinor])=>({method,amountMinor})).concat(receivableMinor>0?[{method:"receivable",amountMinor:receivableMinor}]:[]),grossSalesMinor:value.totalMinor,costMinor:0,expenseMinor:0,profitMinor:0,receivableMinor,payableMinor:0,lowStockCount:0,previousGrossSalesMinor:0,transactionCount:value.transactionCount,averageTicketMinor:value.averageTicketMinor,periodDays:days};
}
export interface ManagementReport { cashInMinor: number; cashOutMinor: number; inventoryValueMinor: number; outputTaxMinor: number; inputTaxMinor: number; aging: { kind: "Piutang" | "Utang"; currentMinor: number; days30Minor: number; days60Minor: number; over90Minor: number }[]; }
export async function getManagementReport(db: RemoteStore, context: ReportingContext,scope:ReportingScope="branch"): Promise<ManagementReport> {
  const rows=await Promise.all(reportBranchIds(context,scope).map(async(target_branch_id)=>{const{data,error}=await db.rpc("get_branch_management_report",{target_branch_id});check(error);const value=object(data),aging=Array.isArray(value.aging)?value.aging:[];return {cashInMinor:number(value.cashInMinor),cashOutMinor:number(value.cashOutMinor),inventoryValueMinor:number(value.inventoryValueMinor),outputTaxMinor:number(value.outputTaxMinor),inputTaxMinor:number(value.inputTaxMinor),aging:aging.map((item)=>{const row=object(item);return {kind:String(row.kind)==="Utang"?"Utang" as const:"Piutang" as const,currentMinor:number(row.currentMinor),days30Minor:number(row.days30Minor),days60Minor:number(row.days60Minor),over90Minor:number(row.over90Minor)}})}}));
  const agingKinds=["Piutang","Utang"] as const;
  return {cashInMinor:rows.reduce((sum,row)=>sum+row.cashInMinor,0),cashOutMinor:rows.reduce((sum,row)=>sum+row.cashOutMinor,0),inventoryValueMinor:rows.reduce((sum,row)=>sum+row.inventoryValueMinor,0),outputTaxMinor:rows.reduce((sum,row)=>sum+row.outputTaxMinor,0),inputTaxMinor:rows.reduce((sum,row)=>sum+row.inputTaxMinor,0),aging:agingKinds.map((kind)=>{const values=rows.flatMap((row)=>row.aging).filter((row)=>row.kind===kind);return {kind,currentMinor:values.reduce((sum,row)=>sum+row.currentMinor,0),days30Minor:values.reduce((sum,row)=>sum+row.days30Minor,0),days60Minor:values.reduce((sum,row)=>sum+row.days60Minor,0),over90Minor:values.reduce((sum,row)=>sum+row.over90Minor,0)}})};
}
export interface AccountBalance { accountCode: string; debitMinor: number; creditMinor: number; balanceMinor: number; }
export interface FinancialStatements { trialBalance: AccountBalance[]; assetsMinor: number; liabilitiesMinor: number; equityMinor: number; revenueMinor: number; expenseMinor: number; netIncomeMinor: number; cashMinor: number; inventoryMinor: number; }
export async function getFinancialStatements(db: RemoteStore, context: ReportingContext,scope:ReportingScope="branch"): Promise<FinancialStatements> {
  let query=db.from("journal_lines").select("account_code,debit_minor,credit_minor,journal_entries!inner(tenant_id,business_id,branch_id,status)").eq("journal_entries.tenant_id",context.tenantId).eq("journal_entries.business_id",context.businessId).eq("journal_entries.status","posted");
  if(scope==="branch"||!["owner","business_manager"].includes(context.role))query=query.eq("journal_entries.branch_id",context.branchId);
  const {data,error}=await query;check(error);
  const map = new Map<string, AccountBalance>(); for (const row of data ?? []) { const current = map.get(row.account_code) ?? { accountCode: row.account_code, debitMinor: 0, creditMinor: 0, balanceMinor: 0 }; current.debitMinor += number(row.debit_minor); current.creditMinor += number(row.credit_minor); current.balanceMinor = current.debitMinor - current.creditMinor; map.set(row.account_code,current); }
  const trialBalance = [...map.values()], sum = (prefix: string, credit = false) => trialBalance.filter((x)=>x.accountCode.startsWith(prefix)).reduce((total,x)=>total+(credit?-x.balanceMinor:x.balanceMinor),0);
  const assetsMinor=sum("1"), liabilitiesMinor=sum("2",true), equityMinor=sum("3",true), revenueMinor=sum("4",true), expenseMinor=sum("5"); return { trialBalance, assetsMinor, liabilitiesMinor, equityMinor, revenueMinor, expenseMinor, netIncomeMinor: revenueMinor-expenseMinor, cashMinor: sum("11"), inventoryMinor: sum("13") };
}
export async function logAuditEvent(db: RemoteStore, input: { id: string; context: LocalTenantContext; action: string; resourceType: string; resourceId?: string | null; result: "success" | "denied" | "failed"; reason?: string; metadata?: Record<string, unknown> }): Promise<void> { const { error } = await db.from("audit_events").insert({ tenant_id: input.context.tenantId, actor_id: input.context.userId, device_id: input.context.deviceId, action: input.action, resource_type: input.resourceType, resource_id: input.resourceId ?? null, result: input.result, reason: input.reason ?? null, correlation_id: input.id, metadata: input.metadata ?? {} }); check(error); }

export interface LocalSaleDraftLine { productId: string; quantity: number; discountMinor: number; }
export interface LocalSaleDraft { id: string; customerId: string | null; lines: LocalSaleDraftLine[]; status: "draft" | "held" | "submitted"; }
export interface LocalPendingGatewayPayment { saleId: string; orderId: string; receiptNumber: string; amount: number; qrString: string | null; qrImageUrl: string | null; paymentUrl: string | null; expiresAt: string; payload: Record<string, unknown>; }
const payments = new Map<string, LocalPendingGatewayPayment>();
const scopeKey = (context: Pick<LocalTenantContext,"tenantId"|"branchId">) => `${context.tenantId}:${context.branchId}`;
export async function loadActiveSaleDraft(db: RemoteStore, context: LocalTenantContext): Promise<LocalSaleDraft | null> {
  const{data,error}=await db.from("sale_drafts").select("id,customer_id,lines").eq("tenant_id",context.tenantId).eq("business_id",context.businessId).eq("branch_id",context.branchId).eq("user_id",context.userId).maybeSingle();check(error);
  if(!data)return null;const lines=Array.isArray(data.lines)?data.lines:[];return{id:data.id,customerId:data.customer_id??null,status:"draft",lines:lines.flatMap((item)=>{const row=object(item),quantity=number(row.quantity),productId=String(row.productId??"");return productId&&quantity>0?[{productId,quantity,discountMinor:Math.max(0,number(row.discountMinor))}]:[]})};
}
export async function saveActiveSaleDraft(db: RemoteStore, input: { id: string; context: LocalTenantContext; customerId?: string | null; lines: LocalSaleDraftLine[]; status?: LocalSaleDraft["status"] }): Promise<void> {
  const{error}=await db.from("sale_drafts").upsert({id:input.id,tenant_id:input.context.tenantId,business_id:input.context.businessId,branch_id:input.context.branchId,user_id:input.context.userId,customer_id:input.customerId??null,lines:input.lines,updated_at:new Date().toISOString()},{onConflict:"tenant_id,business_id,branch_id,user_id"});check(error);
}
export async function clearSaleDraft(db: RemoteStore, draftId: string): Promise<void> { const{error}=await db.from("sale_drafts").delete().eq("id",draftId);check(error); }
export async function savePendingGatewayPayment(_db: RemoteStore, context: LocalTenantContext, payment: LocalPendingGatewayPayment): Promise<void> { payments.set(scopeKey(context), payment); }
export async function loadPendingGatewayPayment(db: RemoteStore, context: LocalTenantContext): Promise<LocalPendingGatewayPayment | null> {
  const { data, error } = await db.rpc("recover_qris_payment_session", { target_branch_id: context.branchId, target_device_id: context.deviceId });
  check(error);
  if(!data||typeof data!=="object")return null;
  const row=object(data),payload=object(row.payload),saleId=String(row.saleId??"");
  if(!saleId)return null;
  const payment:LocalPendingGatewayPayment={saleId,orderId:String(row.orderId??saleId),receiptNumber:String(row.receiptNumber??""),amount:number(row.amount),qrString:typeof row.qrString==="string"?row.qrString:null,qrImageUrl:typeof row.qrImageUrl==="string"?row.qrImageUrl:null,paymentUrl:typeof row.paymentUrl==="string"?row.paymentUrl:null,expiresAt:String(row.expiresAt??""),payload};
  payments.set(scopeKey(context),payment);
  return payment;
}
export async function clearPendingGatewayPayment(_db: RemoteStore, saleId: string): Promise<void> { for (const [key,value] of payments) if (value.saleId===saleId) payments.delete(key); }
