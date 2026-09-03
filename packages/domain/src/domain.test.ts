import { describe, expect, it } from "vitest";
import {
  calculateCart,
  calculateCreditPayment,
  analyzeDemand,
  can,
  detectOperationalAnomalies,
  evaluateStockSale,
  forecastReorder,
  lowStockSignals,
  nextReceiptNumber,
  normalizeBranchCode,
  calculateTax,
  classifyRfm,
  resolveTierPrice,
  slugifyTenantName,
  straightLineDepreciation,
  splitPlatformSettlement,
  areasFor,
  canAccessModule,
} from "./index";

describe("role permission templates", () => {
  it("keeps accounting away from cashier role", () => {
    expect(can("cashier", "accounting.manage.business")).toBe(false);
    expect(can("owner", "accounting.manage.business")).toBe(true);
  });
  it("gives every blueprint role a focused workspace with at most five tabs", () => {
    const roles = ["owner","business_manager","branch_manager","supervisor","cashier","warehouse","purchasing","finance","service_staff","kitchen","waiter","auditor"] as const;
    for (const role of roles) {
      expect(areasFor(role).length).toBeGreaterThan(0);
      expect(areasFor(role).length).toBeLessThanOrEqual(5);
    }
    expect(areasFor("cashier")).not.toContain("reports");
    expect(areasFor("auditor")).not.toContain("pos");
  });
  it("keeps operational modules separated by job", () => {
    expect(canAccessModule("warehouse", "stock_count")).toBe(true);
    expect(canAccessModule("warehouse", "manual_journal")).toBe(false);
    expect(canAccessModule("finance", "manual_journal")).toBe(true);
    expect(canAccessModule("auditor", "expense")).toBe(false);
  });
});

describe("production policies", () => {
  it("blocks cashier negative stock and requires privileged approval", () => {
    expect(
      evaluateStockSale({
        available: 1,
        requested: 2,
        policy: "approval",
        role: "cashier",
      }),
    ).toEqual({ allowed: false, requiresApproval: true, risk: true });
    expect(
      evaluateStockSale({
        available: 1,
        requested: 2,
        policy: "approval",
        role: "supervisor",
        approved: true,
      }).allowed,
    ).toBe(true);
  });
  it("does not claim a forecast before 14 days", () => {
    expect(
      forecastReorder([{ date: "2026-08-01", quantity: 2 }], 3, 5, 2).status,
    ).toBe("insufficient_data");
  });
  it("flags deterministic integrity anomalies", () => {
    expect(
      detectOperationalAnomalies({
        salesMinor: 100,
        costMinor: 120,
        refundMinor: 20,
        cashVarianceMinor: 1,
        negativeStockCount: 1,
      }),
    ).toHaveLength(4);
  });
  it("combines moving average, exponential smoothing and reorder point", () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-07-${String(index + 1).padStart(2, "0")}`,
      quantity: index >= 23 ? 4 : 2,
    }));
    const result = analyzeDemand({ history, stock: 5, minimumStock: 3, leadTimeDays: 4 });
    expect(result.status).toBe("ready");
    expect(result.movingAverage7).toBe(4);
    expect(result.exponentialForecast).toBeGreaterThan(3);
    expect(result.reorderPoint).toBeGreaterThan(5);
    expect(result.suggestedOrder).toBeGreaterThan(0);
  });
  it("flags unusual discounts and possible duplicate groups", () => {
    const signals = detectOperationalAnomalies({
      salesMinor: 100,
      costMinor: 50,
      refundMinor: 0,
      cashVarianceMinor: 0,
      negativeStockCount: 0,
      highDiscountCount: 2,
      possibleDuplicateGroups: 1,
    });
    expect(signals.map((signal) => signal.kind)).toEqual(["unusual_discount", "possible_duplicate"]);
  });
});

describe("onboarding normalization", () => {
  it("creates a safe tenant slug", () => {
    expect(slugifyTenantName("Toko Maju & Jaya")).toBe("toko-maju-jaya");
  });

  it("creates a valid branch code", () => {
    expect(normalizeBranchCode("utama 01")).toBe("UTAMA01");
  });
});

describe("commerce rules", () => {
  it("splits platform QRIS settlement without losing a rupiah", () => {
    const split = splitPlatformSettlement({ grossMinor: 100_000, platformFeeBps: 100, reserveBps: 200 });
    expect(split).toEqual({ grossMinor: 100_000, platformFeeMinor: 1_000, reserveMinor: 2_000, merchantNetMinor: 97_000 });
    expect(split.platformFeeMinor + split.reserveMinor + split.merchantNetMinor).toBe(split.grossMinor);
  });
  it("calculates discount and tax", () => {
    expect(
      calculateCart([
        {
          productId: "p1",
          name: "Produk",
          quantity: 2,
          priceMinor: 10_000,
          discountMinor: 2_000,
          taxRate: 11,
        },
      ]),
    ).toEqual({
      subtotalMinor: 20_000,
      discountMinor: 2_000,
      taxMinor: 1_980,
      totalMinor: 19_980,
      itemCount: 2,
    });
  });

  it("selects the highest applicable wholesale tier", () => {
    expect(resolveTierPrice(12_000, 24, [
      { minimumQuantity: 12, priceMinor: 11_000 },
      { minimumQuantity: 24, priceMinor: 10_000 },
    ])).toBe(10_000);
  });

  it("calculates inclusive and exclusive tax without floating money", () => {
    expect(calculateTax({ amountMinor: 111_000, rate: 11, mode: "inclusive" }))
      .toEqual({ netMinor: 100_000, taxMinor: 11_000, grossMinor: 111_000 });
    expect(calculateTax({ amountMinor: 100_000, rate: 11, mode: "exclusive" }).grossMinor)
      .toBe(111_000);
  });

  it("calculates a partial credit payment without losing the remaining balance", () => {
    expect(calculateCreditPayment({ totalMinor: 39_000, paidNowMinor: 10_000 }))
      .toEqual({ paidNowMinor: 10_000, outstandingMinor: 29_000 });
    expect(() => calculateCreditPayment({ totalMinor: 39_000, paidNowMinor: 39_000 }))
      .toThrow("invalid_credit_payment");
  });

  it("keeps straight-line depreciation exact through the final month", () => {
    const periods = straightLineDepreciation({ costMinor: 1_000_000, residualMinor: 100_000, usefulLifeMonths: 7 });
    expect(periods.at(-1)?.bookValueMinor).toBe(100_000);
    expect(periods.reduce((sum, item) => sum + item.depreciationMinor, 0)).toBe(900_000);
  });

  it("classifies deterministic customer RFM segments", () => {
    expect(classifyRfm({ recencyDays: 10, frequency: 8, monetaryMinor: 2_000_000 })).toBe("champion");
    expect(classifyRfm({ recencyDays: 200, frequency: 1, monetaryMinor: 20_000 })).toBe("hibernating");
  });

  it("creates deterministic receipt numbers", () => {
    expect(
      nextReceiptNumber("utama", 9, new Date("2026-08-09T00:00:00.000Z")),
    ).toBe("UTAMA-20260809-00009");
  });

  it("suggests replenishment for low stock", () => {
    expect(
      lowStockSignals([
        { id: "p1", name: "Beras", stock: 2, minimumStock: 5 },
      ])[0]?.suggestedOrder,
    ).toBe(8);
  });
});
