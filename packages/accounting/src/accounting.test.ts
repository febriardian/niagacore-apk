import { describe, expect, it } from 'vitest';
import { journalFor, validateBalancedEntry } from './index';

describe('journal invariant', () => {
  it('accepts balanced IDR minor units', () => {
    expect(() => validateBalancedEntry([
      { accountCode: '1101', debitMinor: 100000, creditMinor: 0 },
      { accountCode: '4101', debitMinor: 0, creditMinor: 100000 },
    ])).not.toThrow();
  });

  it('rejects unbalanced entries', () => {
    expect(() => validateBalancedEntry([
      { accountCode: '1101', debitMinor: 90000, creditMinor: 0 },
      { accountCode: '4101', debitMinor: 0, creditMinor: 100000 },
    ])).toThrow('journal_not_balanced');
  });
});

describe('automatic journal', () => {
  it('posts sale tax and cost of goods', () => {
    const entry = journalFor({ type: 'sale', totalMinor: 111_000, taxMinor: 11_000, costMinor: 70_000, payment: 'qris' });
    expect(entry.lines.reduce((sum, line) => sum + line.debitMinor, 0)).toBe(181_000);
    expect(entry.lines.reduce((sum, line) => sum + line.creditMinor, 0)).toBe(181_000);
  });
});
