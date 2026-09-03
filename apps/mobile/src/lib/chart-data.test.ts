import { describe, expect, it } from "vitest";

import { compactTrendSeries } from "./chart-data";

describe("compactTrendSeries", () => {
  it("meringkas periode panjang menjadi total bulanan", () => {
    const data = Array.from({ length: 100 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1));
      return { label: date.toISOString().slice(0, 10), amountMinor: 1_000, transactions: 1 };
    });
    const result = compactTrendSeries(data);
    expect(result).toEqual([
      { label: "2026-01", amountMinor: 31_000, transactions: 31 },
      { label: "2026-02", amountMinor: 28_000, transactions: 28 },
      { label: "2026-03", amountMinor: 31_000, transactions: 31 },
      { label: "2026-04", amountMinor: 10_000, transactions: 10 },
    ]);
  });

  it("mempertahankan data harian untuk periode pendek", () => {
    const data = [{ label: "2026-08-30", amountMinor: 20_000, transactions: 1 }];
    expect(compactTrendSeries(data)).toBe(data);
  });
});
