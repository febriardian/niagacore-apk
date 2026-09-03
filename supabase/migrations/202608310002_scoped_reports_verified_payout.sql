begin;

-- Store the operational branch on every journal entry so branch financial
-- statements never silently include other branches.
alter table public.journal_entries add column if not exists branch_id uuid;
alter table public.journal_entries drop constraint if exists journal_entries_tenant_branch_fkey;
alter table public.journal_entries add constraint journal_entries_tenant_branch_fkey
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id);
create index if not exists journal_entries_business_branch_idx
  on public.journal_entries(business_id,branch_id,occurred_at desc);

create or replace function private.resolve_journal_branch(target_tenant uuid,target_source uuid)
returns uuid language sql stable security definer set search_path='' as $$
  select coalesce(
    (select s.branch_id from public.sales s where s.tenant_id=target_tenant and s.id=target_source),
    (select r.branch_id from public.business_records r where r.tenant_id=target_tenant and r.id=target_source),
    (select r.branch_id from public.refunds r where r.tenant_id=target_tenant and r.id=target_source),
    (select s.branch_id from public.payments p join public.sales s on s.tenant_id=p.tenant_id and s.id=p.sale_id where p.tenant_id=target_tenant and p.id=target_source),
    (select a.branch_id from public.fixed_assets a where a.tenant_id=target_tenant and a.id=target_source)
  )
$$;
revoke all on function private.resolve_journal_branch(uuid,uuid) from public,anon,authenticated;

create or replace function private.set_journal_branch()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.branch_id is null then new.branch_id:=private.resolve_journal_branch(new.tenant_id,new.source_id); end if;
  if new.branch_id is not null and not exists(
    select 1 from public.branches b where b.tenant_id=new.tenant_id and b.business_id=new.business_id and b.id=new.branch_id
  ) then raise exception 'journal_branch_mismatch'; end if;
  return new;
end $$;
drop trigger if exists journal_entries_set_branch on public.journal_entries;
create trigger journal_entries_set_branch before insert or update of tenant_id,business_id,source_id,branch_id
on public.journal_entries for each row execute function private.set_journal_branch();

-- This is a one-time metadata backfill, not an accounting mutation. The
-- immutable trigger must not reject it, but is restored inside this same
-- transaction before any payout objects are installed. A failure rolls the
-- whole transaction back, including the trigger change.
drop trigger if exists journal_entries_immutable on public.journal_entries;
update public.journal_entries e set branch_id=private.resolve_journal_branch(e.tenant_id,e.source_id)
where e.branch_id is null and private.resolve_journal_branch(e.tenant_id,e.source_id) is not null;
create trigger journal_entries_immutable before update or delete on public.journal_entries
for each row execute function private.reject_posted_journal_mutation();

-- Manual payout verification and evidence.
alter table public.withdrawal_accounts add column if not exists verified_by uuid references auth.users(id);
alter table public.withdrawal_accounts add column if not exists verified_at timestamptz;
alter table public.withdrawal_accounts add column if not exists verification_note text;
alter table public.withdrawal_requests add column if not exists transfer_evidence_path text;
alter table public.withdrawal_requests add column if not exists paid_at timestamptz;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('payout-evidence','payout-evidence',false,5242880,array['image/jpeg','image/png','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists payout_evidence_admin_read on storage.objects;
drop policy if exists payout_evidence_admin_insert on storage.objects;
create policy payout_evidence_admin_read on storage.objects for select to authenticated using(
  bucket_id='payout-evidence' and private.is_platform_admin()
);
create policy payout_evidence_admin_insert on storage.objects for insert to authenticated with check(
  bucket_id='payout-evidence' and private.is_platform_admin()
);

create or replace function public.admin_verify_withdrawal_account(target_account_id uuid,decision text,note text default null)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); account_row public.withdrawal_accounts%rowtype; next_status text;
begin
  if not private.is_platform_admin() then raise exception 'platform_admin_required'; end if;
  if decision not in('verified','rejected') then raise exception 'invalid_verification_decision'; end if;
  select * into account_row from public.withdrawal_accounts where id=target_account_id for update;
  if account_row.id is null then raise exception 'account_not_found'; end if;
  next_status:=decision;
  update public.withdrawal_accounts set kyc_status=next_status,verified_by=actor,verified_at=now(),verification_note=nullif(trim(note),''),updated_at=now()
  where id=account_row.id;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(account_row.tenant_id,actor,'wallet.account.'||decision,'withdrawal_account',account_row.id::text,'success',jsonb_build_object('note',note));
end $$;

create or replace function public.list_manual_payout_queue()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if not private.is_platform_admin() then raise exception 'platform_admin_required'; end if;
  select jsonb_build_object(
    'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'tenantId',a.tenant_id,'tenantName',t.name,'bankCode',a.bank_code,'accountHolder',a.account_holder,'accountLast4',a.account_last4,'status',a.kyc_status,'createdAt',a.created_at) order by a.created_at) from public.withdrawal_accounts a join public.tenants t on t.id=a.tenant_id where a.active and a.kyc_status='manual_unverified'),'[]'::jsonb),
    'withdrawals',coalesce((select jsonb_agg(jsonb_build_object('id',w.id,'tenantId',w.tenant_id,'tenantName',t.name,'accountId',w.account_id,'bankCode',a.bank_code,'accountHolder',a.account_holder,'accountLast4',a.account_last4,'amountMinor',w.amount_minor,'status',w.status,'createdAt',w.created_at) order by w.created_at) from public.withdrawal_requests w join public.withdrawal_accounts a on a.id=w.account_id join public.tenants t on t.id=w.tenant_id where w.status in('requested','approved')),'[]'::jsonb)
  ) into result;
  return result;
end $$;

create or replace function public.request_withdrawal(target_account_id uuid,amount_minor bigint)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());member public.memberships%rowtype;wallet public.merchant_wallets%rowtype;policy public.wallet_policies%rowtype;request_id uuid:=gen_random_uuid();
begin
  select m.* into member from public.memberships m join public.withdrawal_accounts a on a.tenant_id=m.tenant_id
  where a.id=target_account_id and a.active and a.kyc_status='verified' and m.user_id=actor and m.active and m.role='owner' limit 1;
  if member.id is null then raise exception 'verified_account_required'; end if;
  insert into public.wallet_policies(tenant_id) values(member.tenant_id) on conflict(tenant_id) do nothing;
  select * into policy from public.wallet_policies where tenant_id=member.tenant_id;
  select * into wallet from public.merchant_wallets where tenant_id=member.tenant_id for update;
  if wallet.tenant_id is null then raise exception 'wallet_not_ready'; end if;
  if amount_minor<policy.minimum_withdrawal_minor then raise exception 'minimum_withdrawal_not_met'; end if;
  if wallet.available_minor<amount_minor then raise exception 'insufficient_available_balance'; end if;
  insert into public.withdrawal_requests(id,tenant_id,account_id,amount_minor,requested_by) values(request_id,member.tenant_id,target_account_id,amount_minor,actor);
  perform private.wallet_post(member.tenant_id,'withdrawal_lock','withdrawal',request_id,'withdrawal_lock:'||request_id,0,-amount_minor,0,amount_minor,'{}'::jsonb);
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(member.tenant_id,actor,'wallet.withdrawal.request','withdrawal',request_id::text,'success',jsonb_build_object('amountMinor',amount_minor,'accountId',target_account_id,'payoutMode','manual_verified'));
  return request_id;
end $$;

drop function if exists public.admin_review_withdrawal(uuid,text,text,text);
create or replace function public.admin_review_withdrawal(target_request_id uuid,decision text,transfer_reference text default null,note text default null,evidence_path text default null)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());request_row public.withdrawal_requests%rowtype;account_status text;
begin
  if not private.is_platform_admin() then raise exception 'platform_admin_required'; end if;
  select w.* into request_row from public.withdrawal_requests w where w.id=target_request_id for update;
  if request_row.id is null then raise exception 'withdrawal_not_found'; end if;
  select a.kyc_status into account_status from public.withdrawal_accounts a where a.id=request_row.account_id;
  if account_status<>'verified' then raise exception 'verified_account_required'; end if;
  if decision='approved' and request_row.status='requested' then
    update public.withdrawal_requests set status='approved',reviewed_by=actor,reviewed_at=now(),review_note=nullif(trim(note),''),updated_at=now() where id=request_row.id;
  elsif decision='rejected' and request_row.status in('requested','approved') then
    update public.withdrawal_requests set status='rejected',reviewed_by=actor,reviewed_at=now(),review_note=nullif(trim(note),''),updated_at=now() where id=request_row.id;
    perform private.wallet_post(request_row.tenant_id,'withdrawal_rejected','withdrawal',request_row.id,'withdrawal_rejected:'||request_row.id,0,request_row.amount_minor,0,-request_row.amount_minor,jsonb_build_object('note',note));
  elsif decision='paid' and request_row.status='approved' then
    if char_length(trim(coalesce(transfer_reference,'')))<6 then raise exception 'external_reference_required'; end if;
    if coalesce(evidence_path,'')!~('^'||request_row.tenant_id::text||'/'||request_row.id::text||'/[A-Za-z0-9._-]+$') then raise exception 'transfer_evidence_required'; end if;
    if not exists(select 1 from storage.objects o where o.bucket_id='payout-evidence' and o.name=evidence_path) then raise exception 'transfer_evidence_not_found'; end if;
    update public.withdrawal_requests set status='paid',reviewed_by=actor,reviewed_at=now(),external_reference=trim(transfer_reference),transfer_evidence_path=evidence_path,paid_at=now(),review_note=nullif(trim(note),''),updated_at=now() where id=request_row.id;
    perform private.wallet_post(request_row.tenant_id,'withdrawal_paid','withdrawal',request_row.id,'withdrawal_paid:'||request_row.id,0,0,0,-request_row.amount_minor,jsonb_build_object('externalReference',trim(transfer_reference),'evidencePath',evidence_path));
  else raise exception 'invalid_withdrawal_transition'; end if;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(request_row.tenant_id,actor,'wallet.withdrawal.'||decision,'withdrawal',request_row.id::text,'success',jsonb_build_object('externalReference',transfer_reference,'evidencePath',evidence_path,'note',note));
end $$;

revoke all on function public.admin_verify_withdrawal_account(uuid,text,text),public.list_manual_payout_queue(),public.request_withdrawal(uuid,bigint),public.admin_review_withdrawal(uuid,text,text,text,text) from public,anon;
grant execute on function public.admin_verify_withdrawal_account(uuid,text,text),public.list_manual_payout_queue(),public.admin_review_withdrawal(uuid,text,text,text,text) to authenticated;
grant execute on function public.request_withdrawal(uuid,bigint) to authenticated;

commit;
