begin;

-- The APK Supabase directory is the only canonical database migration chain.
-- This forward-only migration absorbs the former website-only admin schema and
-- connects it to the verified manual-payout contract introduced in 202608310002.

alter table public.platform_admins add column if not exists email text;
alter table public.platform_admins add column if not exists role text not null default 'admin';
alter table public.platform_admins drop constraint if exists platform_admins_role_check;
alter table public.platform_admins add constraint platform_admins_role_check check (
  role in ('super_admin','admin','finance_admin','operations_admin','support','release_manager','auditor')
);

create table if not exists public.platform_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  version_code integer not null check(version_code>0),
  channel text not null check(channel in ('internal','preview','production')),
  status text not null default 'active' check(status in ('draft','active','withdrawn')),
  apk_url text,
  release_notes jsonb not null default '{}'::jsonb,
  mandatory boolean not null default false,
  checksum_sha256 text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique(version_code,channel)
);

create table if not exists public.tenant_feature_flags (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  flag_key text not null check(flag_key~'^[a-z0-9_]{2,80}$'),
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,flag_key)
);

create table if not exists public.platform_incidents (
  id uuid primary key default gen_random_uuid(),
  title text not null check(char_length(trim(title)) between 3 and 180),
  severity text not null check(severity in ('low','medium','high','critical')),
  status text not null check(status in ('investigating','identified','monitoring','resolved')),
  summary text not null default '',
  public_message text,
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.support_cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  opened_by uuid not null references auth.users(id),
  subject text not null check(char_length(trim(subject)) between 3 and 180),
  description text not null check(char_length(trim(description)) between 3 and 5000),
  priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
  status text not null default 'open' check(status in ('open','in_progress','waiting_merchant','resolved','closed')),
  admin_note text,
  assigned_to uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_releases enable row level security;
alter table public.tenant_feature_flags enable row level security;
alter table public.platform_incidents enable row level security;
alter table public.support_cases enable row level security;

create or replace function private.platform_admin_permissions()
returns text[] language sql stable security definer set search_path='' as $$
  select case role
    when 'super_admin' then array[
      'dashboard.read','merchant.read','merchant.review','device.read','wallet.read',
      'payout.account.verify','payout.read','payout.review','payout.pay',
      'payment.read','release.manage','feature_flag.manage','system.read','system.manage',
      'incident.manage','support.manage','nia.read','admin.manage','audit.read'
    ]::text[]
    when 'admin' then array[
      'dashboard.read','merchant.read','merchant.review','device.read','wallet.read',
      'payout.account.verify','payout.read','payout.review','payout.pay',
      'payment.read','release.manage','feature_flag.manage','system.read','system.manage',
      'incident.manage','support.manage','nia.read','audit.read'
    ]::text[]
    when 'finance_admin' then array[
      'dashboard.read','merchant.read','wallet.read','payout.account.verify','payout.read',
      'payout.review','payout.pay','payment.read','audit.read'
    ]::text[]
    when 'operations_admin' then array[
      'dashboard.read','merchant.read','merchant.review','device.read','payment.read',
      'feature_flag.manage','system.read','system.manage','incident.manage','support.manage','nia.read'
    ]::text[]
    when 'support' then array['dashboard.read','merchant.read','device.read','system.read','incident.manage','support.manage']::text[]
    when 'release_manager' then array['dashboard.read','release.manage','feature_flag.manage','system.read']::text[]
    when 'auditor' then array['dashboard.read','merchant.read','wallet.read','payout.read','payment.read','system.read','nia.read','audit.read']::text[]
    else array[]::text[]
  end
  from public.platform_admins
  where user_id=(select auth.uid()) and active
  limit 1;
$$;

create or replace function private.platform_admin_has_permission(requested_permission text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(requested_permission=any(private.platform_admin_permissions()),false);
$$;

revoke all on function private.platform_admin_permissions(),private.platform_admin_has_permission(text) from public,anon;
grant execute on function private.platform_admin_permissions(),private.platform_admin_has_permission(text) to authenticated;

create or replace function public.admin_has_permission(requested_permission text)
returns boolean language sql stable security definer set search_path='' as $$
  select private.platform_admin_has_permission(requested_permission);
$$;

create or replace function public.admin_my_access()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'active',a.active,
    'role',a.role,
    'email',coalesce(a.email,u.email),
    'permissions',private.platform_admin_permissions()
  )
  from public.platform_admins a
  left join auth.users u on u.id=a.user_id
  where a.user_id=(select auth.uid()) and a.active
  limit 1;
$$;

drop policy if exists merchant_verification_admin_all on public.merchant_verifications;
drop policy if exists merchant_verification_admin_read on public.merchant_verifications;
create policy merchant_verification_admin_read on public.merchant_verifications for select to authenticated
  using(private.platform_admin_has_permission('merchant.read'));

drop policy if exists audit_platform_admin_read on public.audit_events;
create policy audit_platform_admin_read on public.audit_events for select to authenticated
  using(private.platform_admin_has_permission('audit.read'));

drop policy if exists ai_usage_platform_admin_read on public.ai_usage;
create policy ai_usage_platform_admin_read on public.ai_usage for select to authenticated
  using(private.platform_admin_has_permission('nia.read'));

drop policy if exists platform_admin_manage on public.platform_admins;
create policy platform_admin_manage on public.platform_admins for all to authenticated
  using(private.platform_admin_has_permission('admin.manage'))
  with check(private.platform_admin_has_permission('admin.manage'));

drop policy if exists platform_releases_admin_all on public.platform_releases;
drop policy if exists platform_releases_admin_read on public.platform_releases;
create policy platform_releases_admin_read on public.platform_releases for select to authenticated
  using(private.platform_admin_has_permission('release.manage'));
drop policy if exists platform_releases_public_active on public.platform_releases;
create policy platform_releases_public_active on public.platform_releases for select to anon,authenticated
  using(status='active' and channel='production');

drop policy if exists feature_flags_admin_all on public.tenant_feature_flags;
drop policy if exists feature_flags_admin_read on public.tenant_feature_flags;
create policy feature_flags_admin_read on public.tenant_feature_flags for select to authenticated
  using(private.platform_admin_has_permission('feature_flag.manage'));
drop policy if exists feature_flags_member_read on public.tenant_feature_flags;
create policy feature_flags_member_read on public.tenant_feature_flags for select to authenticated
  using(private.is_tenant_member(tenant_id));

drop policy if exists platform_incidents_admin_all on public.platform_incidents;
drop policy if exists platform_incidents_admin_read on public.platform_incidents;
create policy platform_incidents_admin_read on public.platform_incidents for select to authenticated
  using(private.platform_admin_has_permission('incident.manage'));
drop policy if exists platform_incidents_public_read on public.platform_incidents;
create policy platform_incidents_public_read on public.platform_incidents for select to anon,authenticated
  using(public_message is not null);

drop policy if exists support_cases_admin_all on public.support_cases;
drop policy if exists support_cases_admin_read on public.support_cases;
create policy support_cases_admin_read on public.support_cases for select to authenticated
  using(private.platform_admin_has_permission('support.manage'));
drop policy if exists support_cases_member_read on public.support_cases;
create policy support_cases_member_read on public.support_cases for select to authenticated
  using(private.is_tenant_member(tenant_id));
drop policy if exists support_cases_member_insert on public.support_cases;
create policy support_cases_member_insert on public.support_cases for insert to authenticated
  with check(private.is_tenant_member(tenant_id) and opened_by=(select auth.uid()));

drop policy if exists payout_evidence_admin_read on storage.objects;
drop policy if exists payout_evidence_admin_insert on storage.objects;
drop policy if exists payout_evidence_admin_delete on storage.objects;
create policy payout_evidence_admin_read on storage.objects for select to authenticated
  using(bucket_id='payout-evidence' and private.platform_admin_has_permission('payout.read'));
create policy payout_evidence_admin_insert on storage.objects for insert to authenticated
  with check(bucket_id='payout-evidence' and private.platform_admin_has_permission('payout.pay'));
create policy payout_evidence_admin_delete on storage.objects for delete to authenticated
  using(bucket_id='payout-evidence' and private.platform_admin_has_permission('payout.pay'));

create or replace function public.review_merchant(target_tenant_id uuid,decision text,note text default null,enable_qris boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.platform_admin_has_permission('merchant.review') then raise exception 'permission_denied'; end if;
  if decision not in('approved','rejected','suspended') then raise exception 'invalid_decision'; end if;
  if enable_qris and decision<>'approved' then raise exception 'qris_requires_approval'; end if;
  if decision in('rejected','suspended') and char_length(trim(coalesce(note,'')))<3 then raise exception 'review_note_required'; end if;
  update public.merchant_verifications set status=decision::public.merchant_verification_status,
    qris_enabled=enable_qris,review_note=nullif(trim(note),''),reviewed_at=now(),reviewed_by=(select auth.uid()),updated_at=now()
  where tenant_id=target_tenant_id;
  if not found then raise exception 'merchant_not_found'; end if;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,reason,metadata)
  values(target_tenant_id,(select auth.uid()),'merchant.review','tenant',target_tenant_id::text,'success',decision,jsonb_build_object('qrisEnabled',enable_qris,'note',note));
end $$;

create or replace function public.admin_verify_withdrawal_account(target_account_id uuid,decision text,note text default null)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); account_row public.withdrawal_accounts%rowtype;
begin
  if not private.platform_admin_has_permission('payout.account.verify') then raise exception 'permission_denied'; end if;
  if decision not in('verified','rejected') then raise exception 'invalid_verification_decision'; end if;
  if decision='rejected' and char_length(trim(coalesce(note,'')))<3 then raise exception 'verification_note_required'; end if;
  select * into account_row from public.withdrawal_accounts where id=target_account_id for update;
  if account_row.id is null then raise exception 'account_not_found'; end if;
  update public.withdrawal_accounts set kyc_status=decision,verified_by=actor,verified_at=now(),
    verification_note=nullif(trim(note),''),updated_at=now() where id=account_row.id;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(account_row.tenant_id,actor,'wallet.account.'||decision,'withdrawal_account',account_row.id::text,'success',jsonb_build_object('note',note));
end $$;

create or replace function public.list_manual_payout_queue()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.platform_admin_has_permission('payout.read') then raise exception 'permission_denied'; end if;
  return jsonb_build_object(
    'accounts',coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'tenantId',a.tenant_id,'tenantName',t.name,'bankCode',a.bank_code,
      'accountHolder',a.account_holder,'accountLast4',a.account_last4,'status',a.kyc_status,
      'active',a.active,'createdAt',a.created_at,'verifiedAt',a.verified_at,
      'verifiedBy',a.verified_by,'verificationNote',a.verification_note
    ) order by case a.kyc_status when 'manual_unverified' then 0 when 'verified' then 1 else 2 end,a.created_at desc)
    from public.withdrawal_accounts a join public.tenants t on t.id=a.tenant_id where a.active),'[]'::jsonb),
    'withdrawals',coalesce((select jsonb_agg(jsonb_build_object(
      'id',w.id,'tenantId',w.tenant_id,'tenantName',t.name,'accountId',w.account_id,
      'bankCode',a.bank_code,'accountHolder',a.account_holder,'accountLast4',a.account_last4,
      'kycStatus',a.kyc_status,'amountMinor',w.amount_minor,'status',w.status,
      'createdAt',w.created_at,'reviewedAt',w.reviewed_at,'paidAt',w.paid_at,
      'externalReference',w.external_reference,'reviewNote',w.review_note,
      'transferEvidencePath',w.transfer_evidence_path
    ) order by case w.status when 'requested' then 0 when 'approved' then 1 else 2 end,w.created_at desc)
    from public.withdrawal_requests w join public.withdrawal_accounts a on a.id=w.account_id
    join public.tenants t on t.id=w.tenant_id where w.created_at>=now()-interval '365 days'),'[]'::jsonb),
    'metrics',jsonb_build_object(
      'accountsWaiting',(select count(*) from public.withdrawal_accounts where active and kyc_status='manual_unverified'),
      'requested',(select count(*) from public.withdrawal_requests where status='requested'),
      'approved',(select count(*) from public.withdrawal_requests where status='approved'),
      'paid30d',(select count(*) from public.withdrawal_requests where status='paid' and paid_at>=now()-interval '30 days')
    )
  );
end $$;

create or replace function public.admin_review_withdrawal(target_request_id uuid,decision text,transfer_reference text default null,note text default null,evidence_path text default null)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); request_row public.withdrawal_requests%rowtype; account_status text;
begin
  if decision='paid' then
    if not private.platform_admin_has_permission('payout.pay') then raise exception 'permission_denied'; end if;
  elsif not private.platform_admin_has_permission('payout.review') then raise exception 'permission_denied'; end if;
  select * into request_row from public.withdrawal_requests where id=target_request_id for update;
  if request_row.id is null then raise exception 'withdrawal_not_found'; end if;
  select kyc_status into account_status from public.withdrawal_accounts where id=request_row.account_id;
  if account_status<>'verified' then raise exception 'verified_account_required'; end if;
  if decision='approved' and request_row.status='requested' then
    update public.withdrawal_requests set status='approved',reviewed_by=actor,reviewed_at=now(),
      review_note=nullif(trim(note),''),updated_at=now() where id=request_row.id;
  elsif decision='rejected' and request_row.status in('requested','approved') then
    if char_length(trim(coalesce(note,'')))<3 then raise exception 'review_note_required'; end if;
    update public.withdrawal_requests set status='rejected',reviewed_by=actor,reviewed_at=now(),
      review_note=trim(note),updated_at=now() where id=request_row.id;
    perform private.wallet_post(request_row.tenant_id,'withdrawal_rejected','withdrawal',request_row.id,
      'withdrawal_rejected:'||request_row.id,0,request_row.amount_minor,0,-request_row.amount_minor,jsonb_build_object('note',note));
  elsif decision='paid' and request_row.status='approved' then
    if char_length(trim(coalesce(transfer_reference,'')))<6 then raise exception 'external_reference_required'; end if;
    if coalesce(evidence_path,'')!~('^'||request_row.tenant_id::text||'/'||request_row.id::text||'/[A-Za-z0-9._-]+$') then raise exception 'transfer_evidence_required'; end if;
    if not exists(select 1 from storage.objects where bucket_id='payout-evidence' and name=evidence_path) then raise exception 'transfer_evidence_not_found'; end if;
    update public.withdrawal_requests set status='paid',reviewed_by=actor,reviewed_at=now(),
      external_reference=trim(transfer_reference),transfer_evidence_path=evidence_path,paid_at=now(),
      review_note=nullif(trim(note),''),updated_at=now() where id=request_row.id;
    perform private.wallet_post(request_row.tenant_id,'withdrawal_paid','withdrawal',request_row.id,
      'withdrawal_paid:'||request_row.id,0,0,0,-request_row.amount_minor,
      jsonb_build_object('externalReference',trim(transfer_reference),'evidencePath',evidence_path));
  else raise exception 'invalid_withdrawal_transition'; end if;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(request_row.tenant_id,actor,'wallet.withdrawal.'||decision,'withdrawal',request_row.id::text,'success',
    jsonb_build_object('externalReference',transfer_reference,'evidencePath',evidence_path,'note',note));
end $$;

create or replace function public.admin_set_feature_flag(target_tenant_id uuid,flag_key text,flag_enabled boolean,flag_config jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.platform_admin_has_permission('feature_flag.manage') then raise exception 'permission_denied'; end if;
  insert into public.tenant_feature_flags(tenant_id,flag_key,enabled,config,updated_by)
  values(target_tenant_id,lower(trim(flag_key)),flag_enabled,coalesce(flag_config,'{}'::jsonb),(select auth.uid()))
  on conflict(tenant_id,flag_key) do update set enabled=excluded.enabled,config=excluded.config,updated_by=excluded.updated_by,updated_at=now();
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(target_tenant_id,(select auth.uid()),'feature_flag.update','tenant_feature_flag',flag_key,'success',jsonb_build_object('enabled',flag_enabled));
end $$;

create or replace function public.admin_publish_release(release_version text,release_version_code integer,release_channel text,release_apk_url text,release_notes jsonb,release_mandatory boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare release_id uuid;
begin
  if not private.platform_admin_has_permission('release.manage') then raise exception 'permission_denied'; end if;
  if release_channel not in('internal','preview','production') or release_version_code<1 then raise exception 'invalid_release'; end if;
  insert into public.platform_releases(version,version_code,channel,status,apk_url,release_notes,mandatory,created_by)
  values(trim(release_version),release_version_code,release_channel,'active',nullif(trim(release_apk_url),''),coalesce(release_notes,'{}'::jsonb),release_mandatory,(select auth.uid()))
  returning id into release_id;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,metadata)
  values((select auth.uid()),'release.publish','platform_release',release_id::text,'success',jsonb_build_object('version',release_version,'channel',release_channel));
  return release_id;
end $$;

create or replace function public.admin_upsert_incident(incident_id uuid,incident_title text,incident_severity text,incident_status text,incident_summary text,incident_public_message text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare target_id uuid;
begin
  if not private.platform_admin_has_permission('incident.manage') then raise exception 'permission_denied'; end if;
  if incident_id is null then
    insert into public.platform_incidents(title,severity,status,summary,public_message,created_by,updated_by)
    values(trim(incident_title),incident_severity,incident_status,coalesce(incident_summary,''),nullif(trim(incident_public_message),''),(select auth.uid()),(select auth.uid())) returning id into target_id;
  else
    update public.platform_incidents set title=trim(incident_title),severity=incident_severity,status=incident_status,
      summary=coalesce(incident_summary,''),public_message=nullif(trim(incident_public_message),''),
      resolved_at=case when incident_status='resolved' then now() else null end,updated_by=(select auth.uid()),updated_at=now()
    where id=incident_id returning id into target_id;
  end if;
  if target_id is null then raise exception 'incident_not_found'; end if;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,metadata)
  values((select auth.uid()),'incident.update','platform_incident',target_id::text,'success',jsonb_build_object('status',incident_status,'severity',incident_severity));
  return target_id;
end $$;

create or replace function public.admin_update_support_case(target_case_id uuid,next_status text,note text default null)
returns void language plpgsql security definer set search_path='' as $$
declare target_tenant uuid;
begin
  if not private.platform_admin_has_permission('support.manage') then raise exception 'permission_denied'; end if;
  if next_status not in('open','in_progress','waiting_merchant','resolved','closed') then raise exception 'invalid_status'; end if;
  update public.support_cases set status=next_status,admin_note=coalesce(nullif(trim(note),''),admin_note),
    assigned_to=(select auth.uid()),updated_at=now() where id=target_case_id returning tenant_id into target_tenant;
  if target_tenant is null then raise exception 'support_case_not_found'; end if;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(target_tenant,(select auth.uid()),'support.update','support_case',target_case_id::text,'success',jsonb_build_object('status',next_status,'note',note));
end $$;

create or replace function public.admin_record_production_gate(target_gate text,target_status text,target_evidence text,target_notes text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.platform_admin_has_permission('system.manage') then raise exception 'permission_denied'; end if;
  if target_status not in('pending','passed','failed','not_applicable') then raise exception 'invalid_gate_status'; end if;
  if target_status='passed' and coalesce(length(trim(target_evidence)),0)<8 then raise exception 'production_gate_evidence_required'; end if;
  update public.production_gate_evidence set status=target_status,evidence_reference=nullif(trim(target_evidence),''),
    notes=target_notes,verified_at=case when target_status='passed' then now() else null end,
    verified_by=(select auth.uid()),updated_at=now() where gate_key=target_gate;
  if not found then raise exception 'unknown_production_gate'; end if;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,metadata)
  values((select auth.uid()),'production_gate.update','production_gate',target_gate,'success',jsonb_build_object('status',target_status,'evidence',target_evidence));
end $$;

create or replace function public.admin_set_platform_admin_role(target_user_id uuid,next_role text,next_active boolean,note text)
returns void language plpgsql security definer set search_path='' as $$
declare old_role text; old_active boolean;
begin
  if not private.platform_admin_has_permission('admin.manage') then raise exception 'permission_denied'; end if;
  if next_role not in('super_admin','admin','finance_admin','operations_admin','support','release_manager','auditor') then raise exception 'invalid_admin_role'; end if;
  if target_user_id=(select auth.uid()) and not next_active then raise exception 'cannot_deactivate_self'; end if;
  if char_length(trim(coalesce(note,'')))<3 then raise exception 'change_note_required'; end if;
  select role,active into old_role,old_active from public.platform_admins where user_id=target_user_id for update;
  if old_role is null then raise exception 'platform_admin_not_found'; end if;
  update public.platform_admins set role=next_role,active=next_active where user_id=target_user_id;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,reason,metadata)
  values((select auth.uid()),'platform_admin.access.update','platform_admin',target_user_id::text,'success',trim(note),
    jsonb_build_object('oldRole',old_role,'newRole',next_role,'oldActive',old_active,'newActive',next_active));
end $$;

create or replace function public.admin_control_center_snapshot()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permissions text[]:=private.platform_admin_permissions();
begin
  if permissions is null or cardinality(permissions)=0 then raise exception 'platform_admin_required'; end if;
  return jsonb_build_object(
    'access',public.admin_my_access(),
    'metrics',jsonb_build_object(
      'merchantTotal',(select count(*) from public.merchant_verifications),
      'merchantPending',(select count(*) from public.merchant_verifications where status='pending'),
      'qrisActive',(select count(*) from public.merchant_verifications where qris_enabled),
      'accountsWaiting',(select count(*) from public.withdrawal_accounts where active and kyc_status='manual_unverified'),
      'withdrawalsWaiting',(select count(*) from public.withdrawal_requests where status in('requested','approved')),
      'availableWalletMinor',coalesce((select sum(available_minor) from public.merchant_wallets),0),
      'pendingWalletMinor',coalesce((select sum(pending_minor) from public.merchant_wallets),0),
      'reserveMinor',coalesce((select sum(reserve_minor) from public.merchant_wallets),0),
      'openIncidents',case when 'incident.manage'=any(permissions) then (select count(*) from public.platform_incidents where status<>'resolved') else 0 end,
      'openSupport',case when 'support.manage'=any(permissions) then (select count(*) from public.support_cases where status not in('resolved','closed')) else 0 end,
      'syncFailures',case when 'system.read'=any(permissions) then (select count(*) from public.sync_failure_events where status='requires_review') else 0 end
    ),
    'merchants',case when 'merchant.read'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'tenantId',tenant_id,'ownerName',owner_name,'businessName',business_name,'status',status,
      'qrisEnabled',qris_enabled,'submittedAt',submitted_at,'reviewedAt',reviewed_at,'reviewNote',review_note
    ) order by submitted_at desc) from public.merchant_verifications),'[]'::jsonb) else '[]'::jsonb end,
    'wallets',case when 'wallet.read'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'tenantId',w.tenant_id,'tenantName',t.name,'pendingMinor',w.pending_minor,'availableMinor',w.available_minor,
      'reserveMinor',w.reserve_minor,'lockedMinor',w.withdrawal_locked_minor,'updatedAt',w.updated_at
    ) order by w.updated_at desc) from public.merchant_wallets w join public.tenants t on t.id=w.tenant_id),'[]'::jsonb) else '[]'::jsonb end,
    'ledger',case when 'wallet.read'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'id',l.id,'tenantId',l.tenant_id,'tenantName',t.name,'eventType',l.event_type,'referenceType',l.reference_type,
      'referenceId',l.reference_id,'pendingDeltaMinor',l.pending_delta_minor,'availableDeltaMinor',l.available_delta_minor,
      'reserveDeltaMinor',l.reserve_delta_minor,'lockedDeltaMinor',l.withdrawal_locked_delta_minor,'createdAt',l.created_at
    ) order by l.created_at desc) from (select * from public.wallet_ledger order by created_at desc limit 250) l join public.tenants t on t.id=l.tenant_id),'[]'::jsonb) else '[]'::jsonb end,
    'devices',case when 'device.read'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'id',d.id,'tenantId',d.tenant_id,'tenantName',t.name,'branchName',b.name,'label',d.label,'status',d.status,
      'platform',d.platform,'model',d.model,'osVersion',d.os_version,'appVersion',d.app_version,'lastSeenAt',d.last_seen_at
    ) order by d.last_seen_at desc nulls last) from public.devices d join public.tenants t on t.id=d.tenant_id join public.branches b on b.id=d.branch_id),'[]'::jsonb) else '[]'::jsonb end,
    'payments',case when 'payment.read'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'tenantId',p.tenant_id,'tenantName',t.name,'saleId',p.sale_id,'method',p.method,
      'amountMinor',p.amount_minor,'provider',p.provider,'providerReference',p.provider_reference,
      'providerStatus',p.provider_status,'paidAt',p.paid_at,'createdAt',p.created_at
    ) order by p.created_at desc) from (select * from public.payments order by created_at desc limit 250) p join public.tenants t on t.id=p.tenant_id),'[]'::jsonb) else '[]'::jsonb end,
    'refunds',case when 'payment.read'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'tenantId',r.tenant_id,'tenantName',t.name,'saleId',r.sale_id,'amountMinor',r.amount_minor,
      'reason',r.reason,'status',r.status,'provider',r.provider,'providerReference',r.provider_reference,'occurredAt',r.occurred_at
    ) order by r.occurred_at desc) from (select * from public.refunds order by occurred_at desc limit 250) r join public.tenants t on t.id=r.tenant_id),'[]'::jsonb) else '[]'::jsonb end,
    'syncFailures',case when 'system.read'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'id',f.id,'tenantId',f.tenant_id,'tenantName',t.name,'branchId',f.branch_id,'deviceId',f.device_id,
      'aggregateType',f.aggregate_type,'aggregateId',f.aggregate_id,'errorCode',f.error_code,'status',f.status,'createdAt',f.created_at
    ) order by f.created_at desc) from (select * from public.sync_failure_events order by created_at desc limit 250) f join public.tenants t on t.id=f.tenant_id),'[]'::jsonb) else '[]'::jsonb end,
    'productionGates',case when 'system.read'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'key',gate_key,'status',status,'evidenceReference',evidence_reference,'notes',notes,'verifiedAt',verified_at,'updatedAt',updated_at
    ) order by gate_key) from public.production_gate_evidence),'[]'::jsonb) else '[]'::jsonb end,
    'releases',case when 'release.manage'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'id',id,'version',version,'versionCode',version_code,'channel',channel,'status',status,'apkUrl',apk_url,
      'mandatory',mandatory,'checksumSha256',checksum_sha256,'createdAt',created_at
    ) order by version_code desc) from public.platform_releases),'[]'::jsonb) else '[]'::jsonb end,
    'featureFlags',case when 'feature_flag.manage'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'tenantId',f.tenant_id,'tenantName',t.name,'key',f.flag_key,'enabled',f.enabled,'config',f.config,'updatedAt',f.updated_at
    ) order by t.name,f.flag_key) from public.tenant_feature_flags f join public.tenants t on t.id=f.tenant_id),'[]'::jsonb) else '[]'::jsonb end,
    'incidents',case when 'incident.manage'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'id',id,'title',title,'severity',severity,'status',status,'summary',summary,'publicMessage',public_message,'createdAt',created_at
    ) order by created_at desc) from public.platform_incidents),'[]'::jsonb) else '[]'::jsonb end,
    'supportCases',case when 'support.manage'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'id',c.id,'tenantId',c.tenant_id,'tenantName',t.name,'subject',c.subject,'description',c.description,
      'priority',c.priority,'status',c.status,'adminNote',c.admin_note,'createdAt',c.created_at
    ) order by c.created_at desc) from public.support_cases c join public.tenants t on t.id=c.tenant_id),'[]'::jsonb) else '[]'::jsonb end,
    'niaUsage',case when 'nia.read'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'feature',feature,'model',model,'calls',calls,'inputTokens',input_tokens,'outputTokens',output_tokens,'costUsd',cost_usd
    ) order by calls desc) from (select feature,model,count(*) calls,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(cost_usd) cost_usd
      from public.ai_usage where created_at>=now()-interval '30 days' group by feature,model) usage),'[]'::jsonb) else '[]'::jsonb end,
    'adminUsers',case when 'admin.manage'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'userId',a.user_id,'email',coalesce(a.email,u.email),'role',a.role,'active',a.active,'createdAt',a.created_at
    ) order by a.created_at) from public.platform_admins a left join auth.users u on u.id=a.user_id),'[]'::jsonb) else '[]'::jsonb end,
    'auditEvents',case when 'audit.read'=any(permissions) then coalesce((select jsonb_agg(jsonb_build_object(
      'id',e.id,'tenantId',e.tenant_id,'actorId',e.actor_id,'action',e.action,'resourceType',e.resource_type,
      'resourceId',e.resource_id,'result',e.result,'reason',e.reason,'metadata',e.metadata,'occurredAt',e.occurred_at
    ) order by e.occurred_at desc) from (select * from public.audit_events order by occurred_at desc limit 500) e),'[]'::jsonb) else '[]'::jsonb end
  );
end $$;

-- Snapshot lama tidak memiliki pemisahan hak akses per domain. Cabut aksesnya
-- apabila fungsi tersebut masih ada pada database hasil migrasi versi lama.
do $$
begin
  if to_regprocedure('public.admin_model_b_snapshot()') is not null then
    execute 'revoke all on function public.admin_model_b_snapshot() from public, anon, authenticated';
  end if;
  if to_regprocedure('public.admin_platform_snapshot()') is not null then
    execute 'revoke all on function public.admin_platform_snapshot() from public, anon, authenticated';
  end if;
end $$;

revoke all on function public.admin_has_permission(text),public.admin_my_access(),public.admin_control_center_snapshot(),
  public.admin_verify_withdrawal_account(uuid,text,text),public.list_manual_payout_queue(),
  public.admin_review_withdrawal(uuid,text,text,text,text),public.admin_set_platform_admin_role(uuid,text,boolean,text),
  public.admin_set_feature_flag(uuid,text,boolean,jsonb),public.admin_publish_release(text,integer,text,text,jsonb,boolean),
  public.admin_upsert_incident(uuid,text,text,text,text,text),public.admin_update_support_case(uuid,text,text),
  public.admin_record_production_gate(text,text,text,text) from public,anon;

grant execute on function public.admin_has_permission(text),public.admin_my_access(),public.admin_control_center_snapshot(),
  public.admin_verify_withdrawal_account(uuid,text,text),public.list_manual_payout_queue(),
  public.admin_review_withdrawal(uuid,text,text,text,text),public.admin_set_platform_admin_role(uuid,text,boolean,text),
  public.admin_set_feature_flag(uuid,text,boolean,jsonb),public.admin_publish_release(text,integer,text,text,jsonb,boolean),
  public.admin_upsert_incident(uuid,text,text,text,text,text),public.admin_update_support_case(uuid,text,text),
  public.admin_record_production_gate(text,text,text,text) to authenticated;

commit;
