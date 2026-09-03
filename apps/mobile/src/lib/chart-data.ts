export interface SalesTrendPoint {
  label: string;
  amountMinor: number;
  transactions: number;
}

export function compactTrendSeries(data: SalesTrendPoint[]): SalesTrendPoint[] {
  if (data.length <= 90) return data;
  const months = new Map<string, { amountMinor: number; transactions: number }>();
  for (const item of data) {
    const month = item.label.slice(0, 7);
    const current = months.get(month) ?? { amountMinor: 0, transactions: 0 };
    current.amountMinor += item.amountMinor;
    current.transactions += item.transactions;
    months.set(month, current);
  }
  return [...months]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => ({ label, ...value }));
}
