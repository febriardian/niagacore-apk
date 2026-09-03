import { z } from "zod";

export const RoleSchema = z.enum([
  "owner",
  "business_manager",
  "branch_manager",
  "supervisor",
  "cashier",
  "warehouse",
  "purchasing",
  "finance",
  "service_staff",
  "kitchen",
  "waiter",
  "auditor",
]);
export type Role = z.infer<typeof RoleSchema>;

export const PermissionSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.(own|branch|business|tenant)$/,
    "Permission must use resource.action.scope",
  );
export type Permission = z.infer<typeof PermissionSchema>;

export const MutationEnvelopeSchema = z.object({
  mutationId: z.uuid(),
  idempotencyKey: z.string().min(16).max(160),
  deviceId: z.uuid(),
  tenantId: z.uuid(),
  businessId: z.uuid(),
  branchId: z.uuid(),
  actorId: z.uuid(),
  aggregateType: z.enum([
    "sale_draft",
    "sale",
    "product",
    "customer",
    "device",
    "inventory_movement",
    "expense",
    "purchase",
    "receivable",
    "payable",
    "appointment",
    "dining_table",
    "partner",
    "supplier",
    "purchase_order",
    "goods_receipt",
    "supplier_bill",
    "purchase_return",
    "stock_count",
    "stock_transfer",
    "stock_adjustment",
    "price_list",
    "bundle",
    "recipe",
    "modifier",
    "lot",
    "customer_segment",
    "loyalty",
    "service",
    "kitchen_order",
    "shift",
    "cash_movement",
    "refund",
    "asset",
    "manual_journal",
    "fiscal_period",
    "tax",
    "staff",
    "hardware",
    "notification",
    "accounting_settings",
    "approval",
  ]),
  aggregateId: z.uuid(),
  operation: z.enum(["create", "update", "archive"]),
  baseVersion: z.number().int().nonnegative().nullable(),
  occurredAt: z.iso.datetime({ offset: true }),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type MutationEnvelope = z.infer<typeof MutationEnvelopeSchema>;

export const SyncReceiptSchema = z.object({
  mutationId: z.uuid(),
  status: z.enum(["accepted", "duplicate", "rejected", "conflict"]),
  serverVersion: z.number().int().nonnegative().optional(),
  errorCode: z.string().optional(),
});
export type SyncReceipt = z.infer<typeof SyncReceiptSchema>;

export const TenantContextSchema = z.object({
  tenantId: z.uuid(),
  businessId: z.uuid(),
  branchId: z.uuid(),
  deviceId: z.uuid(),
  userId: z.uuid(),
  role: RoleSchema,
});
export type TenantContext = z.infer<typeof TenantContextSchema>;

export const PaymentMethodSchema = z.enum([
  "cash",
  "qris",
  "transfer",
  "card",
  "credit",
]);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const ProductSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  branchId: z.uuid(),
  sku: z.string().min(1),
  barcode: z.string().nullable(),
  name: z.string().min(1),
  category: z.string(),
  priceMinor: z.number().int().nonnegative(),
  costMinor: z.number().int().nonnegative(),
  stock: z.number(),
  minimumStock: z.number().nonnegative(),
  unit: z.string(),
  taxRate: z.number().min(0).max(100),
  active: z.boolean(),
  version: z.number().int().nonnegative(),
});
export type Product = z.infer<typeof ProductSchema>;

export const CustomerSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  name: z.string().min(1),
  phone: z.string().nullable(),
  email: z.email().nullable(),
  points: z.number().int().nonnegative(),
  balanceMinor: z.number().int(),
  version: z.number().int().nonnegative(),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const SaleLineSchema = z.object({
  productId: z.uuid(),
  name: z.string(),
  quantity: z.number().positive(),
  priceMinor: z.number().int().nonnegative(),
  discountMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
});
export type SaleLine = z.infer<typeof SaleLineSchema>;

export const SaleSchema = z.object({
  id: z.uuid(),
  receiptNumber: z.string(),
  tenantId: z.uuid(),
  businessId: z.uuid(),
  branchId: z.uuid(),
  cashierId: z.uuid(),
  customerId: z.uuid().nullable(),
  lines: z.array(SaleLineSchema).min(1),
  subtotalMinor: z.number().int().nonnegative(),
  discountMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  paidMinor: z.number().int().nonnegative(),
  paymentMethod: PaymentMethodSchema,
  status: z.enum(["pending", "paid", "void", "refunded"]),
  occurredAt: z.iso.datetime({ offset: true }),
  syncStatus: z.enum(["local", "pending", "synced", "conflict"]),
});
export type Sale = z.infer<typeof SaleSchema>;

export const SyncBatchSchema = z.object({
  deviceId: z.uuid(),
  cursor: z.string().nullable(),
  mutations: z.array(MutationEnvelopeSchema).max(100),
});
export type SyncBatch = z.infer<typeof SyncBatchSchema>;
