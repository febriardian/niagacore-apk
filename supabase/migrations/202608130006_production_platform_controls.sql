begin;

-- Final product decision: one NiagaCore platform merchant account receives
-- gateway payments. Tenant balances are projections of this append-only ledger;
-- NiagaCore never treats a client callback as proof of payment.
create table public.platform_payment_configuration (
  id boolean primary key default true check (id),
  payment_model text not null default 'platform_wallet' check (payment_model='platform_wallet'),
  environment text not null default 'production' check (environment='production'),
  currency text not null default 'IDR' check (currency='IDR'),
  payout_mode text not null default 'manual_approved' check (payout_mode in ('manual_approved','provider_disbursement')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.platform_payment_configuration(id) values(true)
on conflict(id) do update set payment_model='platform_wallet',environment='production';

create table public.production_gate_evidence (
  gate_key text primary key,
  status text not null default 'pending' check(status in ('pending','passed','failed','not_applicable')),
  evidence_reference text,
  verified_at timestamptz,
  verified_by uuid references auth.users(id),
  notes text,
  updated_at timestamptz not null default now()
);
insert into public.production_gate_evidence(gate_key,notes) values
 ('automated_source','Set by CI only after fresh lint, typecheck and tests pass.'),
 ('midtrans_production','Requires a real low-value create, webhook, settlement and refund cycle.'),
 ('printer_58mm','Requires selected physical model and recorded test.'),
 ('printer_80mm','Requires selected physical model and recorded test.'),
 ('barcode_scanner','Requires selected physical HID/USB/Bluetooth model and recorded test.'),
 ('accounting_tax_review','Requires Indonesian accountant/tax professional sign-off.'),
 ('security_review','Requires tenant isolation and production configuration evidence.'),
 ('backup_restore','Requires isolated restore drill evidence.'),
 ('legal_privacy','Requires owner/legal review of PDP, PSE, terms and payment model.'),
 ('signed_apk_upgrade','Requires APK signed with the final id.niagacore.app key and upgrade test.'),
 ('closed_pilot','Requires evidence from real businesses; source code cannot self-certify this.')
on conflict(gate_key) do nothing;

alter table public.platform_payment_configuration enable row level security;
alter table public.production_gate_evidence enable row level security;
create policy platform_payment_admin_read on public.platform_payment_configuration
  for select to authenticated using(private.is_platform_admin());
create policy production_gate_admin_read on public.production_gate_evidence
  for select to authenticated using(private.is_platform_admin());

create or replace function private.reject_append_only_mutation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  raise exception 'append_only_record';
end;
$$;
drop trigger if exists wallet_ledger_append_only on public.wallet_ledger;
create trigger wallet_ledger_append_only before update or delete on public.wallet_ledger
for each row execute function private.reject_append_only_mutation();
drop trigger if exists audit_events_append_only on public.audit_events;
create trigger audit_events_append_only before update or delete on public.audit_events
for each row execute function private.reject_append_only_mutation();

create or replace function public.admin_record_production_gate(
  target_gate text,target_status text,target_evidence text,target_notes text default null
) returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_platform_admin() then raise exception 'platform_admin_required'; end if;
  if target_status not in ('pending','passed','failed','not_applicable') then raise exception 'invalid_gate_status'; end if;
  if target_status='passed' and coalesce(length(trim(target_evidence)),0)<8 then raise exception 'production_gate_evidence_required'; end if;
  update public.production_gate_evidence set status=target_status,evidence_reference=nullif(trim(target_evidence),''),
    notes=target_notes,verified_at=case when target_status='passed' then now() else null end,
    verified_by=auth.uid(),updated_at=now() where gate_key=target_gate;
  if not found then raise exception 'unknown_production_gate'; end if;
end;
$$;
revoke all on function public.admin_record_production_gate(text,text,text,text) from public;
grant execute on function public.admin_record_production_gate(text,text,text,text) to authenticated;

commit;
