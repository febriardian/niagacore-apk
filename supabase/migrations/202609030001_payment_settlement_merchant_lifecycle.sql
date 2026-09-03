begin;

-- Keep payment reconciliation, wallet settlement, and merchant lifecycle as
-- separate operational concepts. Historical sales, payments, and ledger rows
-- remain append-only and are never reset by these controls.
alter table public.tenants
  add column if not exists operational_status text not null default 'active'
    check (operational_status in ('active','closed')),
  add column if not exists admin_archived boolean not null default false,
  add column if not exists current_period_started_at timestamptz not null default now(),
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references auth.users(id),
  add column if not exists lifecycle_reason text;

create table if not exists public.merchant_operating_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sequence_no integer not null check (sequence_no > 0),
  started_at timestamptz not null,
  ended_at timestamptz,
  started_by uuid references auth.users(id),
  reason text not null check (char_length(reason) >= 8),
  created_at timestamptz not null default now(),
  unique (tenant_id, sequence_no)
);

create unique index if not exists merchant_operating_period_open_idx
  on public.merchant_operating_periods(tenant_id) where ended_at is null;

create table if not exists public.merchant_lifecycle_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  actor_id uuid not null references auth.users(id),
  action text not null check (action in ('archive','unarchive','start_period','close','reopen')),
  reason text not null check (char_length(reason) >= 8),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

insert into public.merchant_operating_periods(tenant_id,sequence_no,started_at,reason)
select t.id,1,t.created_at,'Periode awal dari data merchant yang sudah tersedia'
from public.tenants t
where not exists(select 1 from public.merchant_operating_periods p where p.tenant_id=t.id);

alter table public.merchant_operating_periods enable row level security;
alter table public.merchant_lifecycle_events enable row level security;
create policy merchant_operating_period_admin_read on public.merchant_operating_periods
  for select to authenticated using (private.platform_admin_has_permission('merchant.read'));
create policy merchant_lifecycle_event_admin_read on public.merchant_lifecycle_events
  for select to authenticated using (private.platform_admin_has_permission('merchant.read'));

create or replace function private.platform_admin_permissions()
returns text[] language sql stable security definer set search_path='' as $$
  select case role
    when 'super_admin' then array['dashboard.read','merchant.read','merchant.review','merchant.lifecycle','device.read','device.manage','wallet.read','payout.account.verify','payout.read','payout.review','payout.pay','payment.read','payment.reconcile','release.manage','release.publish','feature_flag.manage','system.read','system.manage','system.verify','incident.manage','support.manage','nia.read','admin.manage','admin.invite','audit.read']::text[]
    when 'admin' then array['dashboard.read','merchant.read','merchant.review','device.read','device.manage','wallet.read','payout.account.verify','payout.read','payout.review','payout.pay','payment.read','payment.reconcile','release.manage','release.publish','feature_flag.manage','system.read','system.manage','system.verify','incident.manage','support.manage','nia.read','audit.read']::text[]
    when 'finance_admin' then array['dashboard.read','merchant.read','wallet.read','payout.account.verify','payout.read','payout.review','payout.pay','payment.read','payment.reconcile','audit.read']::text[]
    when 'operations_admin' then array['dashboard.read','merchant.read','merchant.review','device.read','device.manage','payment.read','payment.reconcile','feature_flag.manage','system.read','system.manage','incident.manage','support.manage','nia.read']::text[]
    when 'support' then array['dashboard.read','merchant.read','device.read','system.read','incident.manage','support.manage']::text[]
    when 'release_manager' then array['dashboard.read','release.manage','release.publish','feature_flag.manage','system.read']::text[]
    when 'auditor' then array['dashboard.read','merchant.read','wallet.read','payout.read','payment.read','system.read','nia.read','audit.read']::text[]
    else array[]::text[] end
  from public.platform_admins where user_id=(select auth.uid()) and active limit 1;
$$;

create or replace function public.admin_payment_settlement_snapshot()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permissions text[]:=private.platform_admin_permissions();
begin
  if permissions is null or cardinality(permissions)=0 then raise exception 'platform_admin_required'; end if;
  return jsonb_build_object(
    'merchants',case when 'merchant.read'=any(permissions) then coalesce((select jsonb_agg(row_to_json(x)) from(
      select t.id "tenantId",v.owner_name "ownerName",coalesce(v.business_name,t.name) "businessName",
        coalesce(v.status::text,'pending') status,coalesce(v.qris_enabled,false) "qrisEnabled",
        coalesce(v.submitted_at,t.created_at) "submittedAt",v.reviewed_at "reviewedAt",v.review_note "reviewNote",
        t.operational_status "operationalStatus",t.admin_archived "adminArchived",t.current_period_started_at "currentPeriodStartedAt"
      from public.tenants t left join public.merchant_verifications v on v.tenant_id=t.id
      order by t.admin_archived,t.created_at desc)x),'[]'::jsonb) else '[]'::jsonb end,
    'payments',case when 'payment.read'=any(permissions) then coalesce((select jsonb_agg(row_to_json(x)) from(
      select p.id,p.tenant_id "tenantId",t.name "tenantName",p.sale_id "saleId",p.method,p.amount_minor "amountMinor",
        p.provider,p.provider_reference "providerReference",p.provider_status "providerStatus",
        p.reconciliation_status "reconciliationStatus",p.last_reconciled_at "lastReconciledAt",
        p.paid_at "paidAt",p.created_at "createdAt",
        coalesce(p.provider_status in ('expire','expired') or (p.provider_status='pending' and p.created_at<now()-interval '15 minutes'),false) "isExpired"
      from public.payments p join public.tenants t on t.id=p.tenant_id
      where p.method='qris' order by p.created_at desc limit 500)x),'[]'::jsonb) else '[]'::jsonb end,
    'expiredPayments',case when 'payment.read'=any(permissions) then coalesce((select jsonb_agg(row_to_json(x)) from(
      select p.id,p.tenant_id "tenantId",t.name "tenantName",p.sale_id "saleId",p.method,p.amount_minor "amountMinor",
        p.provider,p.provider_reference "providerReference",p.provider_status "providerStatus",
        p.reconciliation_status "reconciliationStatus",p.last_reconciled_at "lastReconciledAt",
        p.paid_at "paidAt",p.created_at "createdAt",true "isExpired"
      from public.payments p join public.tenants t on t.id=p.tenant_id
      where p.method='qris' and (p.provider_status in ('expire','expired') or (p.provider_status='pending' and p.created_at<now()-interval '15 minutes'))
      order by p.created_at desc limit 500)x),'[]'::jsonb) else '[]'::jsonb end,
    'settlements',case when 'wallet.read'=any(permissions) then coalesce((select jsonb_agg(row_to_json(x)) from(
      select p.id,p.tenant_id "tenantId",t.name "tenantName",p.sale_id "saleId",p.provider_reference "providerReference",
        p.amount_minor "grossMinor",p.provider_status "providerStatus",p.reconciliation_status "reconciliationStatus",
        p.last_reconciled_at "lastReconciledAt",p.paid_at "paidAt",p.created_at "createdAt",
        coalesce((select -sum(l.available_delta_minor) from public.wallet_ledger l where l.tenant_id=p.tenant_id and l.reference_id=p.sale_id and l.event_type='platform_fee'),0) "feeMinor",
        coalesce((select sum(l.reserve_delta_minor) from public.wallet_ledger l where l.tenant_id=p.tenant_id and l.reference_id=p.sale_id and l.event_type='reserve_hold'),0) "reserveMinor",
        coalesce((select sum(l.pending_delta_minor+l.available_delta_minor) from public.wallet_ledger l where l.tenant_id=p.tenant_id and l.reference_id=p.sale_id),0) "netMinor",
        exists(select 1 from public.wallet_ledger l where l.tenant_id=p.tenant_id and l.reference_id=p.sale_id and l.event_type='settlement_release') "ledgerReleased"
      from public.payments p join public.tenants t on t.id=p.tenant_id
      where p.method='qris' and p.provider_status in ('settlement','capture','success')
      order by p.paid_at desc nulls last limit 500)x),'[]'::jsonb) else '[]'::jsonb end
  );
end $$;

create or replace function public.admin_manage_merchant_lifecycle(target_tenant_id uuid,target_action text,target_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare t public.tenants%rowtype; next_sequence integer;
begin
  if not private.platform_admin_has_permission('merchant.lifecycle') then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if target_action not in ('archive','unarchive','start_period','close','reopen') then raise exception 'invalid_lifecycle_action'; end if;
  if char_length(trim(coalesce(target_reason,'')))<8 then raise exception 'action_reason_required'; end if;
  select * into t from public.tenants where id=target_tenant_id for update;
  if t.id is null then raise exception 'merchant_not_found'; end if;

  if target_action='archive' then
    update public.tenants set admin_archived=true,lifecycle_reason=trim(target_reason),updated_at=now() where id=t.id;
  elsif target_action='unarchive' then
    update public.tenants set admin_archived=false,lifecycle_reason=trim(target_reason),updated_at=now() where id=t.id;
  elsif target_action='start_period' then
    update public.merchant_operating_periods set ended_at=now() where tenant_id=t.id and ended_at is null;
    select coalesce(max(sequence_no),0)+1 into next_sequence from public.merchant_operating_periods where tenant_id=t.id;
    insert into public.merchant_operating_periods(tenant_id,sequence_no,started_at,started_by,reason) values(t.id,next_sequence,now(),(select auth.uid()),trim(target_reason));
    update public.tenants set current_period_started_at=now(),lifecycle_reason=trim(target_reason),updated_at=now() where id=t.id;
  elsif target_action='close' then
    if exists(select 1 from public.withdrawal_requests where tenant_id=t.id and status in ('requested','approved')) then raise exception 'merchant_has_open_withdrawal'; end if;
    if exists(select 1 from public.merchant_wallets where tenant_id=t.id and pending_minor+available_minor+reserve_minor+withdrawal_locked_minor<>0) then raise exception 'merchant_wallet_not_empty'; end if;
    update public.tenants set operational_status='closed',closed_at=now(),closed_by=(select auth.uid()),lifecycle_reason=trim(target_reason),updated_at=now() where id=t.id;
    update public.merchant_verifications set status='suspended',qris_enabled=false,review_note=trim(target_reason),reviewed_at=now(),reviewed_by=(select auth.uid()) where tenant_id=t.id;
  elsif target_action='reopen' then
    update public.tenants set operational_status='active',closed_at=null,closed_by=null,lifecycle_reason=trim(target_reason),updated_at=now() where id=t.id;
  end if;

  insert into public.merchant_lifecycle_events(tenant_id,actor_id,action,reason,metadata)
  values(t.id,(select auth.uid()),target_action,trim(target_reason),jsonb_build_object('previousStatus',t.operational_status,'previousArchived',t.admin_archived));
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,reason)
  values(t.id,(select auth.uid()),'merchant.lifecycle.'||target_action,'merchant',t.id::text,'success',trim(target_reason));
end $$;

revoke all on function public.admin_payment_settlement_snapshot(),public.admin_manage_merchant_lifecycle(uuid,text,text) from public,anon;
grant execute on function public.admin_payment_settlement_snapshot(),public.admin_manage_merchant_lifecycle(uuid,text,text) to authenticated;

commit;
