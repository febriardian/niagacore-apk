begin;

-- Compatibility checkpoint. The authoritative Model-B wallet, receipt
-- verification, encrypted bank account, settlement, reserve, refund and
-- manual-withdrawal schema is installed by migration 202608100007.
-- A former version recreated three wallet tables with incompatible columns.
-- This no-op preserves the migration sequence for clean installs and upgrades.

comment on table public.merchant_wallets is
  'Projected merchant balance; rebuildable from append-only wallet_ledger.';
comment on table public.wallet_ledger is
  'Authoritative append-only Model-B wallet ledger.';
comment on table public.receipt_verifications is
  'Public-token metadata for completed transaction receipt verification.';

commit;
