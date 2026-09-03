begin;

-- Sensitive platform operations use granular permissions and AAL2. The early
-- single-operator exception is restricted to super_admin and remains audited.
create or replace function private.platform_admin_permissions()
returns text[] language sql stable security definer set search_path='' as $$
  select case role
    when 'super_admin' then array[
      'dashboard.read','merchant.read','merchant.review','device.read','wallet.read',
      'payout.account.verify','payout.read','payout.review','payout.pay',
      'payment.read','payment.reconcile','release.manage','release.publish',
      'feature_flag.manage','system.read','system.manage','system.verify',
      'incident.manage','support.manage','nia.read','admin.manage','audit.read'
    ]::text[]
    when 'admin' then array[
      'dashboard.read','merchant.read','merchant.review','device.read','wallet.read',
      'payout.account.verify','payout.read','payout.review','payout.pay',
      'payment.read','payment.reconcile','release.manage','release.publish',
      'feature_flag.manage','system.read','system.manage','system.verify',
      'incident.manage','support.manage','nia.read','audit.read'
    ]::text[]
    when 'finance_admin' then array[
      'dashboard.read','merchant.read','wallet.read','payout.account.verify','payout.read',
      'payout.review','payout.pay','payment.read','payment.reconcile','audit.read'
    ]::text[]
    when 'operations_admin' then array[
      'dashboard.read','merchant.read','merchant.review','device.read','payment.read',
      'payment.reconcile','feature_flag.manage','system.read','system.manage',
      'incident.manage','support.manage','nia.read'
    ]::text[]
    when 'support' then array['dashboard.read','merchant.read','device.read','system.read','incident.manage','support.manage']::text[]
    when 'release_manager' then array['dashboard.read','release.manage','release.publish','feature_flag.manage','system.read']::text[]
    when 'auditor' then array['dashboard.read','merchant.read','wallet.read','payout.read','payment.read','system.read','nia.read','audit.read']::text[]
    else array[]::text[]
  end
  from public.platform_admins
  where user_id=(select auth.uid()) and active
  limit 1;
$$;

create or replace function private.require_platform_admin_mfa()
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' then raise exception 'mfa_required'; end if;
end $$;
revoke all on function private.require_platform_admin_mfa() from public,anon,authenticated;

create or replace function public.admin_my_access()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'active',a.active,'role',a.role,'email',coalesce(a.email,u.email),'userId',a.user_id,
    'permissions',private.platform_admin_permissions()
  )
  from public.platform_admins a left join auth.users u on u.id=a.user_id
  where a.user_id=(select auth.uid()) and a.active limit 1;
$$;

-- Settlement release is a scheduled backend operation, never a generic admin RPC.
revoke all on function public.release_due_wallet_settlements(integer) from public,anon,authenticated;
revoke all on function public.release_due_wallet_reserves(integer) from public,anon,authenticated;
grant execute on function public.release_due_wallet_settlements(integer),public.release_due_wallet_reserves(integer) to service_role;

alter table public.withdrawal_requests add column if not exists approved_by uuid references auth.users(id);
alter table public.withdrawal_requests add column if not exists approved_at timestamptz;
alter table public.withdrawal_requests add column if not exists paid_by uuid references auth.users(id);
update public.withdrawal_requests set approved_by=reviewed_by,approved_at=reviewed_at
where status in('approved','paid') and approved_by is null;

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
      'createdAt',w.created_at,'reviewedAt',w.reviewed_at,'approvedBy',w.approved_by,
      'approvedAt',w.approved_at,'paidBy',w.paid_by,'paidAt',w.paid_at,
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

drop function if exists public.admin_review_withdrawal(uuid,text,text,text,text);
create or replace function public.admin_review_withdrawal(
  target_request_id uuid,decision text,transfer_reference text default null,note text default null,
  evidence_path text default null,confirm_single_operator boolean default false
) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); request_row public.withdrawal_requests%rowtype;
  account_status text; actor_role text;
begin
  if decision='paid' then
    if not private.platform_admin_has_permission('payout.pay') then raise exception 'permission_denied'; end if;
  elsif not private.platform_admin_has_permission('payout.review') then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  select role into actor_role from public.platform_admins where user_id=actor and active;
  select * into request_row from public.withdrawal_requests where id=target_request_id for update;
  if request_row.id is null then raise exception 'withdrawal_not_found'; end if;
  select kyc_status into account_status from public.withdrawal_accounts where id=request_row.account_id;
  if account_status<>'verified' then raise exception 'verified_account_required'; end if;
  if decision='approved' and request_row.status='requested' then
    update public.withdrawal_requests set status='approved',approved_by=actor,approved_at=now(),
      reviewed_by=actor,reviewed_at=now(),review_note=nullif(trim(note),''),updated_at=now() where id=request_row.id;
  elsif decision='rejected' and request_row.status in('requested','approved') then
    if char_length(trim(coalesce(note,'')))<3 then raise exception 'review_note_required'; end if;
    update public.withdrawal_requests set status='rejected',reviewed_by=actor,reviewed_at=now(),
      review_note=trim(note),updated_at=now() where id=request_row.id;
    perform private.wallet_post(request_row.tenant_id,'withdrawal_rejected','withdrawal',request_row.id,
      'withdrawal_rejected:'||request_row.id,0,request_row.amount_minor,0,-request_row.amount_minor,jsonb_build_object('note',note));
  elsif decision='paid' and request_row.status='approved' then
    if request_row.approved_by=actor then
      if actor_role<>'super_admin' or not confirm_single_operator then raise exception 'maker_checker_required'; end if;
      if char_length(trim(coalesce(note,'')))<8 then raise exception 'single_operator_reason_required'; end if;
    end if;
    if char_length(trim(coalesce(transfer_reference,'')))<6 then raise exception 'external_reference_required'; end if;
    if coalesce(evidence_path,'')!~('^'||request_row.tenant_id::text||'/'||request_row.id::text||'/[A-Za-z0-9._-]+$') then raise exception 'transfer_evidence_required'; end if;
    if not exists(select 1 from storage.objects where bucket_id='payout-evidence' and name=evidence_path) then raise exception 'transfer_evidence_not_found'; end if;
    update public.withdrawal_requests set status='paid',paid_by=actor,paid_at=now(),reviewed_by=actor,reviewed_at=now(),
      external_reference=trim(transfer_reference),transfer_evidence_path=evidence_path,
      review_note=nullif(trim(note),''),updated_at=now() where id=request_row.id;
    perform private.wallet_post(request_row.tenant_id,'withdrawal_paid','withdrawal',request_row.id,
      'withdrawal_paid:'||request_row.id,0,0,0,-request_row.amount_minor,
      jsonb_build_object('externalReference',trim(transfer_reference),'evidencePath',evidence_path));
  else raise exception 'invalid_withdrawal_transition'; end if;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,reason,metadata)
  values(request_row.tenant_id,actor,'wallet.withdrawal.'||decision,'withdrawal',request_row.id::text,'success',nullif(trim(note),''),
    jsonb_build_object('externalReference',transfer_reference,'evidencePath',evidence_path,'singleOperator',request_row.approved_by=actor));
end $$;

-- Production gates have a submission and an independent verification step.
alter table public.production_gate_evidence drop constraint if exists production_gate_evidence_status_check;
alter table public.production_gate_evidence add constraint production_gate_evidence_status_check
  check(status in('pending','submitted','passed','failed','not_applicable'));
alter table public.production_gate_evidence add column if not exists submitted_by uuid references auth.users(id);
alter table public.production_gate_evidence add column if not exists submitted_at timestamptz;
alter table public.production_gate_evidence add column if not exists review_note text;

drop function if exists public.admin_record_production_gate(text,text,text,text);
create or replace function public.admin_submit_production_gate(target_gate text,target_evidence text,target_notes text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.platform_admin_has_permission('system.manage') then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if char_length(trim(coalesce(target_evidence,'')))<8 or char_length(trim(coalesce(target_notes,'')))<8 then
    raise exception 'production_gate_evidence_required';
  end if;
  update public.production_gate_evidence set status='submitted',evidence_reference=trim(target_evidence),notes=trim(target_notes),
    submitted_by=(select auth.uid()),submitted_at=now(),verified_by=null,verified_at=null,review_note=null,updated_at=now()
  where gate_key=target_gate;
  if not found then raise exception 'unknown_production_gate'; end if;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,reason)
  values((select auth.uid()),'production_gate.submit','production_gate',target_gate,'success',trim(target_notes));
end $$;

create or replace function public.admin_review_production_gate(
  target_gate text,decision text,review_reason text,confirm_single_operator boolean default false
) returns void language plpgsql security definer set search_path='' as $$
declare gate_row public.production_gate_evidence%rowtype; actor uuid:=(select auth.uid()); actor_role text;
begin
  if not private.platform_admin_has_permission('system.verify') then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if decision not in('passed','failed') or char_length(trim(coalesce(review_reason,'')))<8 then raise exception 'gate_review_required'; end if;
  select * into gate_row from public.production_gate_evidence where gate_key=target_gate for update;
  if gate_row.status<>'submitted' then raise exception 'gate_not_submitted'; end if;
  if gate_row.submitted_by=actor then
    select role into actor_role from public.platform_admins where user_id=actor and active;
    if actor_role<>'super_admin' or not confirm_single_operator then raise exception 'maker_checker_required'; end if;
  end if;
  update public.production_gate_evidence set status=decision,verified_by=actor,verified_at=now(),
    review_note=trim(review_reason),updated_at=now() where gate_key=target_gate;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,reason,metadata)
  values(actor,'production_gate.'||decision,'production_gate',target_gate,'success',trim(review_reason),
    jsonb_build_object('singleOperator',gate_row.submitted_by=actor,'submittedBy',gate_row.submitted_by));
end $$;

-- Releases are drafted first and can only be activated after every production gate passes.
alter table public.platform_releases add column if not exists signing_certificate_sha256 text;
alter table public.platform_releases add column if not exists provenance_reference text;
alter table public.platform_releases add column if not exists published_by uuid references auth.users(id);
alter table public.platform_releases add column if not exists published_at timestamptz;

drop function if exists public.admin_publish_release(text,integer,text,text,jsonb,boolean);
create or replace function public.admin_create_release_draft(
  release_version text,release_version_code integer,release_apk_url text,release_notes jsonb,
  release_mandatory boolean,release_checksum_sha256 text,release_signing_certificate_sha256 text,
  release_provenance_reference text
) returns uuid language plpgsql security definer set search_path='' as $$
declare release_id uuid;
begin
  if not private.platform_admin_has_permission('release.manage') then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if release_version_code<1 or release_apk_url!~'^https://[^[:space:]]+$' then raise exception 'invalid_release'; end if;
  if lower(trim(release_checksum_sha256))!~'^[a-f0-9]{64}$' or lower(trim(release_signing_certificate_sha256))!~'^[a-f0-9]{64}$' then
    raise exception 'release_integrity_required';
  end if;
  if char_length(trim(coalesce(release_provenance_reference,'')))<8 or jsonb_typeof(release_notes)<>'object' then raise exception 'release_evidence_required'; end if;
  insert into public.platform_releases(version,version_code,channel,status,apk_url,release_notes,mandatory,checksum_sha256,
    signing_certificate_sha256,provenance_reference,created_by)
  values(trim(release_version),release_version_code,'production','draft',trim(release_apk_url),release_notes,release_mandatory,
    lower(trim(release_checksum_sha256)),lower(trim(release_signing_certificate_sha256)),trim(release_provenance_reference),(select auth.uid()))
  returning id into release_id;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,metadata)
  values((select auth.uid()),'release.draft','platform_release',release_id::text,'success',jsonb_build_object('version',release_version));
  return release_id;
end $$;

create or replace function public.admin_publish_release_draft(target_release_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare release_row public.platform_releases%rowtype;
begin
  if not private.platform_admin_has_permission('release.publish') then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if exists(select 1 from public.production_gate_evidence where status<>'passed') then raise exception 'production_gates_incomplete'; end if;
  select * into release_row from public.platform_releases where id=target_release_id for update;
  if release_row.id is null or release_row.status<>'draft' then raise exception 'release_not_draft'; end if;
  if release_row.checksum_sha256!~'^[a-f0-9]{64}$' or release_row.signing_certificate_sha256!~'^[a-f0-9]{64}$' then raise exception 'release_integrity_required'; end if;
  update public.platform_releases set status='withdrawn' where channel='production' and status='active';
  update public.platform_releases set status='active',published_by=(select auth.uid()),published_at=now() where id=target_release_id;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,metadata)
  values((select auth.uid()),'release.publish','platform_release',target_release_id::text,'success',
    jsonb_build_object('version',release_row.version,'checksum',release_row.checksum_sha256,'gateCount',(select count(*) from public.production_gate_evidence)));
end $$;

-- Durable webhook and reconciliation state powers actionable admin screens.
create table public.gateway_webhook_events(
  id bigint generated always as identity primary key,
  provider text not null,
  provider_reference text,
  event_hash text not null check(event_hash~'^[a-f0-9]{64}$'),
  signature_valid boolean not null,
  provider_status text,
  processing_status text not null check(processing_status in('accepted','rejected','failed','duplicate')),
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider,event_hash)
);
create index gateway_webhook_events_time_idx on public.gateway_webhook_events(received_at desc);
alter table public.gateway_webhook_events enable row level security;
create policy gateway_webhook_admin_read on public.gateway_webhook_events for select to authenticated
  using(private.platform_admin_has_permission('payment.read'));

alter table public.payments add column if not exists reconciliation_status text not null default 'not_checked'
  check(reconciliation_status in('not_checked','matched','mismatch','provider_error'));
alter table public.payments add column if not exists last_reconciled_at timestamptz;
alter table public.payments add column if not exists last_reconciled_by uuid references auth.users(id);
alter table public.payments add column if not exists reconciliation_note text;

create or replace function public.record_gateway_webhook_event(
  target_reference text,target_hash text,target_signature_valid boolean,target_provider_status text,
  target_processing_status text,target_error_code text,target_metadata jsonb
) returns void language plpgsql security definer set search_path='' as $$
begin
  if (select auth.role())<>'service_role' then raise exception 'service_role_required'; end if;
  insert into public.gateway_webhook_events(provider,provider_reference,event_hash,signature_valid,provider_status,
    processing_status,error_code,metadata,processed_at)
  values('midtrans',nullif(target_reference,''),target_hash,target_signature_valid,nullif(target_provider_status,''),
    target_processing_status,nullif(target_error_code,''),coalesce(target_metadata,'{}'::jsonb),case when target_processing_status='accepted' then now() end)
  on conflict(provider,event_hash) do update set processing_status='duplicate',processed_at=now();
end $$;

create or replace function public.record_admin_payment_reconciliation(
  order_id text,target_status text,target_note text,target_actor uuid
) returns void language plpgsql security definer set search_path='' as $$
declare payment_row public.payments%rowtype;
begin
  if (select auth.role())<>'service_role' then raise exception 'service_role_required'; end if;
  if not exists(select 1 from public.platform_admins a where a.user_id=target_actor and a.active and a.role in('super_admin','admin','finance_admin','operations_admin')) then
    raise exception 'permission_denied';
  end if;
  select * into payment_row from public.payments where provider='midtrans' and provider_reference=order_id for update;
  if payment_row.id is null then raise exception 'payment_not_found'; end if;
  update public.payments set reconciliation_status=target_status,last_reconciled_at=now(),last_reconciled_by=target_actor,
    reconciliation_note=nullif(trim(target_note),'') where id=payment_row.id;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,reason)
  values(payment_row.tenant_id,target_actor,'payment.reconcile','payment',payment_row.id::text,'success',nullif(trim(target_note),''));
end $$;

create or replace function public.admin_prepare_refund_retry(target_refund_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare refund_row public.refunds%rowtype; order_id text;
begin
  if not private.platform_admin_has_permission('payment.reconcile') then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  select * into refund_row from public.refunds where id=target_refund_id for update;
  if refund_row.id is null or refund_row.status='posted' then raise exception 'refund_not_retryable'; end if;
  select provider_reference into order_id from public.payments where tenant_id=refund_row.tenant_id and sale_id=refund_row.sale_id and provider='midtrans' limit 1;
  if order_id is null then raise exception 'midtrans_payment_not_found'; end if;
  return jsonb_build_object('refundId',refund_row.id,'orderId',order_id,'amount',refund_row.amount_minor,'reason',refund_row.reason);
end $$;

-- Separate snapshot avoids widening the older dashboard contract and contains
-- only live database-derived operational data.
create or replace function public.admin_operations_snapshot()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permissions text[]:=private.platform_admin_permissions();
begin
  if permissions is null or cardinality(permissions)=0 then raise exception 'platform_admin_required'; end if;
  return jsonb_build_object(
    'productionGates',case when 'system.read'=any(permissions) then coalesce((select jsonb_agg(row_to_json(x)) from(
      select gate_key "key",status,evidence_reference "evidenceReference",notes,submitted_by "submittedBy",
        submitted_at "submittedAt",verified_by "verifiedBy",verified_at "verifiedAt",review_note "reviewNote",updated_at "updatedAt"
      from public.production_gate_evidence order by gate_key)x),'[]'::jsonb) else '[]'::jsonb end,
    'releases',case when 'release.manage'=any(permissions) then coalesce((select jsonb_agg(row_to_json(x)) from(
      select id,version,version_code "versionCode",channel,status,apk_url "apkUrl",mandatory,
        checksum_sha256 "checksumSha256",signing_certificate_sha256 "signingCertificateSha256",
        provenance_reference "provenanceReference",created_at "createdAt",published_at "publishedAt"
      from public.platform_releases order by created_at desc limit 100)x),'[]'::jsonb) else '[]'::jsonb end,
    'niaEvaluations',case when 'nia.read'=any(permissions) then coalesce((select jsonb_agg(row_to_json(x)) from(
      select r.id,r.suite,r.provider,r.model,r.status,r.total_cases "totalCases",r.passed_cases "passedCases",
        r.grounding_score "groundingScore",r.regression_score "regressionScore",r.started_at "startedAt",r.completed_at "completedAt"
      from public.nia_evaluation_runs r order by r.started_at desc limit 50)x),'[]'::jsonb) else '[]'::jsonb end,
    'niaHealth',case when 'nia.read'=any(permissions) then jsonb_build_object(
      'activeModels',(select count(*) from public.nia_model_versions where status='active'),
      'failedRuns24h',(select count(*) from public.nia_evaluation_runs where status in('failed','partial') and started_at>=now()-interval '24 hours'),
      'latestEvaluationAt',(select max(completed_at) from public.nia_evaluation_runs),
      'nextEvaluationAt',(select min(next_run_at) from public.nia_evaluation_schedules where active),
      'driftAlerts7d',(select count(*) from public.nia_drift_measurements where status in('warning','drift') and measured_at>=now()-interval '7 days'),
      'failedJobs24h',(select count(*) from public.observability_job_runs where job_name like 'nia.%' and status='failed' and started_at>=now()-interval '24 hours')
    ) else '{}'::jsonb end,
    'systemHealth',case when 'system.read'=any(permissions) then jsonb_build_object(
      'checkedAt',now(),
      'failedJobs24h',(select count(*) from public.observability_job_runs where status='failed' and started_at>=now()-interval '24 hours'),
      'runningJobs',(select count(*) from public.observability_job_runs where status='running'),
      'invalidWebhooks24h',(select count(*) from public.gateway_webhook_events where not signature_valid and received_at>=now()-interval '24 hours'),
      'failedWebhooks24h',(select count(*) from public.gateway_webhook_events where processing_status='failed' and received_at>=now()-interval '24 hours'),
      'paymentMismatches',(select count(*) from public.payments where reconciliation_status='mismatch'),
      'pendingQrisOver15m',(select count(*) from public.payments where method='qris' and provider_status='pending' and created_at<now()-interval '15 minutes'),
      'latestWebhookAt',(select max(received_at) from public.gateway_webhook_events),
      'latestJobAt',(select max(started_at) from public.observability_job_runs)
    ) else '{}'::jsonb end,
    'webhookEvents',case when 'payment.read'=any(permissions) then coalesce((select jsonb_agg(row_to_json(x)) from(
      select id,provider,provider_reference "providerReference",signature_valid "signatureValid",provider_status "providerStatus",
        processing_status "processingStatus",error_code "errorCode",received_at "receivedAt",processed_at "processedAt"
      from public.gateway_webhook_events order by received_at desc limit 250)x),'[]'::jsonb) else '[]'::jsonb end,
    'payments',case when 'payment.read'=any(permissions) then coalesce((select jsonb_agg(row_to_json(x)) from(
      select p.id,p.tenant_id "tenantId",t.name "tenantName",p.sale_id "saleId",p.method,p.amount_minor "amountMinor",
        p.provider,p.provider_reference "providerReference",p.provider_status "providerStatus",
        p.reconciliation_status "reconciliationStatus",p.last_reconciled_at "lastReconciledAt",
        p.reconciliation_note "reconciliationNote",p.paid_at "paidAt",p.created_at "createdAt"
      from public.payments p join public.tenants t on t.id=p.tenant_id order by p.created_at desc limit 250)x),'[]'::jsonb) else '[]'::jsonb end,
    'settlements',case when 'wallet.read'=any(permissions) then coalesce((select jsonb_agg(row_to_json(x)) from(
      select p.id,p.tenant_id "tenantId",t.name "tenantName",p.sale_id "saleId",p.provider_reference "providerReference",
        p.amount_minor "amountMinor",p.provider_status "providerStatus",p.reconciliation_status "reconciliationStatus",
        p.last_reconciled_at "lastReconciledAt",p.reconciliation_note "reconciliationNote",
        exists(select 1 from public.wallet_ledger l where l.tenant_id=p.tenant_id and l.reference_id=p.sale_id and l.event_type='settlement_release') "ledgerReleased",
        p.paid_at "paidAt",p.created_at "createdAt"
      from public.payments p join public.tenants t on t.id=p.tenant_id where p.method='qris' order by p.created_at desc limit 250)x),'[]'::jsonb) else '[]'::jsonb end
  );
end $$;

revoke all on function public.admin_review_withdrawal(uuid,text,text,text,text,boolean),
  public.admin_submit_production_gate(text,text,text),public.admin_review_production_gate(text,text,text,boolean),
  public.admin_create_release_draft(text,integer,text,jsonb,boolean,text,text,text),public.admin_publish_release_draft(uuid),
  public.admin_operations_snapshot(),public.admin_prepare_refund_retry(uuid) from public,anon;
revoke all on function public.admin_my_access(),public.list_manual_payout_queue() from public,anon;
grant execute on function public.admin_review_withdrawal(uuid,text,text,text,text,boolean),
  public.admin_submit_production_gate(text,text,text),public.admin_review_production_gate(text,text,text,boolean),
  public.admin_create_release_draft(text,integer,text,jsonb,boolean,text,text,text),public.admin_publish_release_draft(uuid),
  public.admin_operations_snapshot(),public.admin_prepare_refund_retry(uuid) to authenticated;
grant execute on function public.admin_my_access(),public.list_manual_payout_queue() to authenticated;
revoke all on function public.record_gateway_webhook_event(text,text,boolean,text,text,text,jsonb),
  public.record_admin_payment_reconciliation(text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.record_gateway_webhook_event(text,text,boolean,text,text,text,jsonb),
  public.record_admin_payment_reconciliation(text,text,text,uuid) to service_role;

commit;
