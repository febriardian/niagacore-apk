export interface JournalLine {
  accountCode: string;
  debitMinor: number;
  creditMinor: number;
}

export function validateBalancedEntry(lines: readonly JournalLine[]): void {
  if (lines.length < 2) throw new Error('journal_requires_two_lines');
  const debit = lines.reduce((sum, line) => sum + line.debitMinor, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditMinor, 0);
  if (debit !== credit) throw new Error('journal_not_balanced');
  if (lines.some((line) => line.debitMinor < 0 || line.creditMinor < 0)) {
    throw new Error('journal_negative_amount');
  }
}

export type AccountingEvent =
  | { type: 'sale'; totalMinor: number; taxMinor: number; costMinor: number; payment: 'cash' | 'qris' | 'transfer' | 'card' | 'credit' }
  | { type: 'expense'; amountMinor: number; paidFrom: 'cash' | 'bank' }
  | { type: 'purchase'; amountMinor: number; payment: 'cash' | 'bank' | 'credit' };

export interface JournalEntry { memo: string; lines: JournalLine[] }

export function journalFor(event: AccountingEvent): JournalEntry {
  let entry: JournalEntry;
  if (event.type === 'sale') {
    const netRevenue = event.totalMinor - event.taxMinor;
    const debitCode = event.payment === 'cash' ? '1101' : event.payment === 'credit' ? '1201' : '1102';
    entry = { memo: 'Penjualan otomatis', lines: [
      { accountCode: debitCode, debitMinor: event.totalMinor, creditMinor: 0 },
      { accountCode: '4101', debitMinor: 0, creditMinor: netRevenue },
      ...(event.taxMinor ? [{ accountCode: '2103', debitMinor: 0, creditMinor: event.taxMinor }] : []),
      ...(event.costMinor ? [
        { accountCode: '5101', debitMinor: event.costMinor, creditMinor: 0 },
        { accountCode: '1301', debitMinor: 0, creditMinor: event.costMinor },
      ] : []),
    ] };
  } else if (event.type === 'expense') {
    entry = { memo: 'Beban operasional', lines: [
      { accountCode: '6101', debitMinor: event.amountMinor, creditMinor: 0 },
      { accountCode: event.paidFrom === 'cash' ? '1101' : '1102', debitMinor: 0, creditMinor: event.amountMinor },
    ] };
  } else {
    entry = { memo: 'Pembelian persediaan', lines: [
      { accountCode: '1301', debitMinor: event.amountMinor, creditMinor: 0 },
      { accountCode: event.payment === 'cash' ? '1101' : event.payment === 'bank' ? '1102' : '2101', debitMinor: 0, creditMinor: event.amountMinor },
    ] };
  }
  validateBalancedEntry(entry.lines);
  return entry;
}
