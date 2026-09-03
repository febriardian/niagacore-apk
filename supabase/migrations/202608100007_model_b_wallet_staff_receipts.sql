begin;

-- Model B: one platform Midtrans account, with a per-tenant internal ledger.
-- Payout remains manual until provider KYC and a licensed disbursement connector
-- are explicitly enabled. Money movement is append-only and idempotent.

create table if not exists public.wallet_policies (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  platform_fee_bps integer not null default 100 check (platform_fee_bps between 0 and 5000),
  reserve_bps integer not null default 200 check (reserve_bps between 0 and 5000),
  settlement_delay_hours integer not null default 24 check (settlement_delay_hours between 0 and 720),
  reserve_days integer not null default 30 check (reserve_days between 0 and 365),
  minimum_withdrawal_minor bigint not null default 50000 check (minimum_withdrawal_minor >= 0),
  automatic_payout_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  check (platform_fee_bps + reserve_bps <= 9000),
  check (automatic_payout_enabled = false)
);

create table if not exists public.merchant_wallets (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  currency text not null default 'IDR' check (currency = 'IDR'),
  pending_minor bigint not null default 0,
  available_minor bigint not null default 0,
  reserve_minor bigint not null default 0,
  withdrawal_locked_minor bigint not null default 0,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_type text not null check (event_type in (
    'payment_gross','platform_fee','reserve_hold','settlement_release',
    'reserve_release','refund','withdrawal_lock','withdrawal_rejected','withdrawal_paid','manual_adjustment'
  )),
  reference_type text not null,
  reference_id uuid,
  idempotency_key text not null,
  pending_delta_minor bigint not null default 0,
  available_delta_minor bigint not null default 0,
  reserve_delta_minor bigint not null default 0,
  withdrawal_locked_delta_minor bigint not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check (pending_delta_minor <> 0 or available_delta_minor <> 0 or reserve_delta_minor <> 0 or withdrawal_locked_delta_minor <> 0)
);

create table if not exists public.withdrawal_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  bank_code text not null,
  account_holder text not null,
  account_last4 text not null check (account_last4 ~ '^[0-9]{4}$'),
  encrypted_account jsonb not null,
  kyc_status text not null default 'manual_unverified' check (kyc_status in ('manual_unverified','verified','rejected')),
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table if not exists public.withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  status text not null default 'requested' check (status in ('requested','approved','rejected','paid','cancelled')),
  payout_mode text not null default 'manual' check (payout_mode = 'manual'),
  requested_by uuid not null references auth.users(id),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  external_reference text,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, account_id) references public.withdrawal_accounts(tenant_id, id),
  unique (tenant_id, id)
);

create table if not exists public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null,
  role public.membership_role not null check (role in ('supervisor','cashier')),
  branch_ids uuid[] not null,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by uuid not null references auth.users(id),
  accepted_by uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists staff_invitation_pending_email
  on public.staff_invitations(tenant_id, lower(email)) where status='pending';

create table if not exists public.staff_device_pins (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  pin_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id,user_id,device_id),
  foreign key (tenant_id,device_id) references public.devices(tenant_id,id)
);

create table if not exists public.receipt_verifications (
  sale_id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  public_token uuid not null default gen_random_uuid() unique,
  receipt_number text not null,
  total_minor bigint not null,
  payment_method text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id,sale_id) references public.sales(tenant_id,id) on delete cascade
);

create index if not exists wallet_ledger_tenant_created_idx on public.wallet_ledger(tenant_id,created_at desc);
create index if not exists withdrawals_status_created_idx on public.withdrawal_requests(status,created_at desc);
create index if not exists staff_invitations_email_idx on public.staff_invitations(lower(email),status);

alter table public.wallet_policies enable row level security;
alter table public.merchant_wallets enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.withdrawal_accounts enable row level security;
alter table public.withdrawal_requests enable row level security;
alter table public.staff_invitations enable row level security;
alter table public.staff_device_pins enable row level security;
alter table public.receipt_verifications enable row level security;

create policy wallet_policy_owner_read on public.wallet_policies for select using (
  exists(select 1 from public.memberships m where m.tenant_id=wallet_policies.tenant_id and m.user_id=(select auth.uid()) and m.active and m.role='owner')
);
create policy merchant_wallet_member_read on public.merchant_wallets for select using (
  exists(select 1 from public.memberships m where m.tenant_id=merchant_wallets.tenant_id and m.user_id=(select auth.uid()) and m.active and m.role in ('owner','supervisor'))
);
create policy wallet_ledger_member_read on public.wallet_ledger for select using (
  exists(select 1 from public.memberships m where m.tenant_id=wallet_ledger.tenant_id and m.user_id=(select auth.uid()) and m.active and m.role in ('owner','supervisor'))
);
create policy withdrawal_accounts_owner_read on public.withdrawal_accounts for select using (
  exists(select 1 from public.memberships m where m.tenant_id=withdrawal_accounts.tenant_id and m.user_id=(select auth.uid()) and m.active and m.role='owner')
);
create policy withdrawal_requests_owner_read on public.withdrawal_requests for select using (
  exists(select 1 from public.memberships m where m.tenant_id=withdrawal_requests.tenant_id and m.user_id=(select auth.uid()) and m.active and m.role='owner')
);
create policy staff_invitations_owner_read on public.staff_invitations for select using (
  exists(select 1 from public.memberships m where m.tenant_id=staff_invitations.tenant_id and m.user_id=(select auth.uid()) and m.active and m.role='owner')
  or lower(email)=lower(coalesce((select auth.jwt()->>'email'),''))
);
create policy staff_pins_self_read on public.staff_device_pins for select using (user_id=(select auth.uid()));
create policy receipt_member_read on public.receipt_verifications for select using (
  exists(select 1 from public.memberships m where m.tenant_id=receipt_verifications.tenant_id and m.user_id=(select auth.uid()) and m.active)
);

create or replace function private.wallet_post(
  target_tenant uuid, event_name text, reference_kind text, target_reference uuid,
  idempotency text, pending_delta bigint, available_delta bigint,
  reserve_delta bigint, locked_delta bigint, details jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare entry_id uuid;
begin
  insert into public.merchant_wallets(tenant_id) values(target_tenant) on conflict(tenant_id) do nothing;
  insert into public.wallet_ledger(tenant_id,event_type,reference_type,reference_id,idempotency_key,
    pending_delta_minor,available_delta_minor,reserve_delta_minor,withdrawal_locked_delta_minor,metadata)
  values(target_tenant,event_name,reference_kind,target_reference,idempotency,pending_delta,available_delta,reserve_delta,locked_delta,details)
  on conflict(tenant_id,idempotency_key) do nothing returning id into entry_id;
  if entry_id is null then return null; end if;
  update public.merchant_wallets set
    pending_minor=pending_minor+pending_delta,
    available_minor=available_minor+available_delta,
    reserve_minor=reserve_minor+reserve_delta,
    withdrawal_locked_minor=withdrawal_locked_minor+locked_delta,
    version=version+1,updated_at=now()
  where tenant_id=target_tenant;
  return entry_id;
end; $$;

create or replace function private.on_qris_sale_paid()
returns trigger language plpgsql security definer set search_path='' as $$
declare policy public.wallet_policies%rowtype; fee bigint; reserve_amount bigint;
begin
  if new.payment_method<>'qris' or new.status<>'paid' or coalesce(old.status,'')='paid' then return new; end if;
  insert into public.wallet_policies(tenant_id) values(new.tenant_id) on conflict(tenant_id) do nothing;
  select * into policy from public.wallet_policies where tenant_id=new.tenant_id;
  fee:=round(new.total_minor*policy.platform_fee_bps::numeric/10000);
  reserve_amount:=round(new.total_minor*policy.reserve_bps::numeric/10000);
  perform private.wallet_post(new.tenant_id,'payment_gross','sale',new.id,'payment_gross:'||new.id,new.total_minor,0,0,0,jsonb_build_object('receiptNumber',new.receipt_number));
  if fee>0 then perform private.wallet_post(new.tenant_id,'platform_fee','sale',new.id,'platform_fee:'||new.id,-fee,0,0,0,jsonb_build_object('basisPoints',policy.platform_fee_bps)); end if;
  if reserve_amount>0 then perform private.wallet_post(new.tenant_id,'reserve_hold','sale',new.id,'reserve_hold:'||new.id,-reserve_amount,0,reserve_amount,0,jsonb_build_object('releaseAfter',now()+make_interval(days=>policy.reserve_days))); end if;
  insert into public.receipt_verifications(sale_id,tenant_id,receipt_number,total_minor,payment_method,occurred_at)
  values(new.id,new.tenant_id,new.receipt_number,new.total_minor,new.payment_method,new.occurred_at)
  on conflict(sale_id) do nothing;
  return new;
end; $$;
drop trigger if exists qris_sale_wallet_credit on public.sales;
create trigger qris_sale_wallet_credit after update of status on public.sales
for each row execute function private.on_qris_sale_paid();

create or replace function private.on_any_paid_sale_receipt()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='paid' then
    insert into public.receipt_verifications(sale_id,tenant_id,receipt_number,total_minor,payment_method,occurred_at)
    values(new.id,new.tenant_id,new.receipt_number,new.total_minor,new.payment_method,new.occurred_at)
    on conflict(sale_id) do nothing;
  end if;
  return new;
end; $$;
drop trigger if exists paid_sale_receipt_insert on public.sales;
create trigger paid_sale_receipt_insert after insert on public.sales
for each row execute function private.on_any_paid_sale_receipt();

create or replace function public.release_due_wallet_settlements(limit_rows integer default 200)
returns integer language plpgsql security definer set search_path='' as $$
declare sale_row public.sales%rowtype; policy public.wallet_policies%rowtype; fee bigint; reserve_amount bigint; released integer:=0;
begin
  if not private.is_platform_admin() and coalesce(auth.role(),'')<>'service_role' then raise exception 'platform_admin_required'; end if;
  for sale_row in
    select s.* from public.sales s join public.payments p on p.sale_id=s.id and p.tenant_id=s.tenant_id
    join public.wallet_policies wp on wp.tenant_id=s.tenant_id
    where s.payment_method='qris' and s.status='paid' and p.paid_at <= now()-make_interval(hours=>wp.settlement_delay_hours)
      and not exists(select 1 from public.wallet_ledger l where l.tenant_id=s.tenant_id and l.idempotency_key='settlement_release:'||s.id)
    order by p.paid_at limit greatest(1,least(limit_rows,1000)) for update of s skip locked
  loop
    select * into policy from public.wallet_policies where tenant_id=sale_row.tenant_id;
    fee:=round(sale_row.total_minor*policy.platform_fee_bps::numeric/10000);
    reserve_amount:=round(sale_row.total_minor*policy.reserve_bps::numeric/10000);
    perform private.wallet_post(sale_row.tenant_id,'settlement_release','sale',sale_row.id,'settlement_release:'||sale_row.id,
      -(sale_row.total_minor-fee-reserve_amount),sale_row.total_minor-fee-reserve_amount,0,0,'{}'::jsonb);
    released:=released+1;
  end loop;
  return released;
end; $$;

create or replace function public.release_due_wallet_reserves(limit_rows integer default 200)
returns integer language plpgsql security definer set search_path='' as $$
declare hold_row record; remaining_reserve bigint; released integer:=0;
begin
  if not private.is_platform_admin() and coalesce(auth.role(),'')<>'service_role' then raise exception 'platform_admin_required'; end if;
  for hold_row in
    select l.tenant_id,l.reference_id,l.reserve_delta_minor
    from public.wallet_ledger l
    join public.sales s on s.id=l.reference_id and s.tenant_id=l.tenant_id and s.status='paid'
    where l.event_type='reserve_hold'
      and coalesce((l.metadata->>'releaseAfter')::timestamptz,'infinity'::timestamptz)<=now()
      and not exists(select 1 from public.wallet_ledger r where r.tenant_id=l.tenant_id and r.idempotency_key='reserve_release:'||l.reference_id)
    order by l.created_at limit greatest(1,least(limit_rows,1000))
  loop
    select greatest(0,hold_row.reserve_delta_minor + coalesce(sum(l.reserve_delta_minor),0)) into remaining_reserve
    from public.wallet_ledger l
    where l.tenant_id=hold_row.tenant_id and l.event_type='refund' and l.metadata->>'saleId'=hold_row.reference_id::text;
    if remaining_reserve>0 then
      perform private.wallet_post(hold_row.tenant_id,'reserve_release','sale',hold_row.reference_id,'reserve_release:'||hold_row.reference_id,
        0,remaining_reserve,-remaining_reserve,0,'{}'::jsonb);
      released:=released+1;
    end if;
  end loop;
  return released;
end; $$;

create or replace function private.on_midtrans_refund_posted()
returns trigger language plpgsql security definer set search_path='' as $$
declare wallet public.merchant_wallets%rowtype; take_available bigint; take_reserve bigint; take_pending bigint;
begin
  if new.provider<>'midtrans' or new.status<>'posted' or coalesce(old.status,'')='posted' then return new; end if;
  insert into public.merchant_wallets(tenant_id) values(new.tenant_id) on conflict(tenant_id) do nothing;
  select * into wallet from public.merchant_wallets where tenant_id=new.tenant_id for update;
  take_available:=least(greatest(wallet.available_minor,0),new.amount_minor);
  take_reserve:=least(greatest(wallet.reserve_minor,0),new.amount_minor-take_available);
  take_pending:=new.amount_minor-take_available-take_reserve;
  perform private.wallet_post(new.tenant_id,'refund','refund',new.id,'refund:'||new.id,-take_pending,-take_available,-take_reserve,0,jsonb_build_object('saleId',new.sale_id));
  return new;
end; $$;
drop trigger if exists refund_wallet_debit on public.refunds;
create trigger refund_wallet_debit after update of status on public.refunds
for each row execute function private.on_midtrans_refund_posted();

create or replace function public.request_withdrawal(target_account_id uuid, amount_minor bigint)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); member public.memberships%rowtype; wallet public.merchant_wallets%rowtype; policy public.wallet_policies%rowtype; request_id uuid:=gen_random_uuid();
begin
  select m.* into member from public.memberships m join public.withdrawal_accounts a on a.tenant_id=m.tenant_id
    where a.id=target_account_id and a.active and m.user_id=actor and m.active and m.role='owner' limit 1;
  if member.id is null then raise exception 'owner_required'; end if;
  insert into public.wallet_policies(tenant_id) values(member.tenant_id) on conflict(tenant_id) do nothing;
  select * into policy from public.wallet_policies where tenant_id=member.tenant_id;
  select * into wallet from public.merchant_wallets where tenant_id=member.tenant_id for update;
  if amount_minor<policy.minimum_withdrawal_minor then raise exception 'minimum_withdrawal_not_met'; end if;
  if wallet.available_minor<amount_minor then raise exception 'insufficient_available_balance'; end if;
  insert into public.withdrawal_requests(id,tenant_id,account_id,amount_minor,requested_by)
  values(request_id,member.tenant_id,target_account_id,amount_minor,actor);
  perform private.wallet_post(member.tenant_id,'withdrawal_lock','withdrawal',request_id,'withdrawal_lock:'||request_id,0,-amount_minor,0,amount_minor,'{}'::jsonb);
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(member.tenant_id,actor,'wallet.withdrawal.request','withdrawal',request_id::text,'success',jsonb_build_object('amountMinor',amount_minor,'payoutMode','manual'));
  return request_id;
end; $$;

create or replace function public.admin_review_withdrawal(target_request_id uuid, decision text, transfer_reference text default null, note text default null)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); request_row public.withdrawal_requests%rowtype;
begin
  if not private.is_platform_admin() then raise exception 'platform_admin_required'; end if;
  select * into request_row from public.withdrawal_requests where id=target_request_id for update;
  if request_row.id is null then raise exception 'withdrawal_not_found'; end if;
  if decision='approved' and request_row.status='requested' then
    update public.withdrawal_requests set status='approved',reviewed_by=actor,reviewed_at=now(),review_note=nullif(trim(note),'') where id=request_row.id;
  elsif decision='rejected' and request_row.status in ('requested','approved') then
    update public.withdrawal_requests set status='rejected',reviewed_by=actor,reviewed_at=now(),review_note=nullif(trim(note),''),updated_at=now() where id=request_row.id;
    perform private.wallet_post(request_row.tenant_id,'withdrawal_rejected','withdrawal',request_row.id,'withdrawal_rejected:'||request_row.id,0,request_row.amount_minor,0,-request_row.amount_minor,jsonb_build_object('note',note));
  elsif decision='paid' and request_row.status='approved' then
    if char_length(trim(coalesce(transfer_reference,'')))<4 then raise exception 'external_reference_required'; end if;
    update public.withdrawal_requests set status='paid',reviewed_by=actor,reviewed_at=now(),external_reference=trim(transfer_reference),review_note=nullif(trim(note),''),updated_at=now() where id=request_row.id;
    perform private.wallet_post(request_row.tenant_id,'withdrawal_paid','withdrawal',request_row.id,'withdrawal_paid:'||request_row.id,0,0,0,-request_row.amount_minor,jsonb_build_object('externalReference',trim(transfer_reference)));
  else raise exception 'invalid_withdrawal_transition'; end if;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(request_row.tenant_id,actor,'wallet.withdrawal.'||decision,'withdrawal',request_row.id::text,'success',jsonb_build_object('externalReference',transfer_reference,'note',note));
end; $$;

create or replace function public.create_staff_invitation(target_email text, target_role public.membership_role, target_branch_ids uuid[])
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); member public.memberships%rowtype; invitation_id uuid:=gen_random_uuid(); normalized text:=lower(trim(target_email)); target_tenant uuid;
begin
  select b.tenant_id into target_tenant from public.branches b where b.id=target_branch_ids[1] and b.active;
  select * into member from public.memberships where tenant_id=target_tenant and user_id=actor and active and role='owner' limit 1;
  if member.id is null then raise exception 'owner_required'; end if;
  if coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'mfa_required'; end if;
  if target_role not in ('supervisor','cashier') or normalized!~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid_invitation'; end if;
  if cardinality(target_branch_ids)=0 or exists(select 1 from unnest(target_branch_ids) b where not exists(select 1 from public.branches br where br.id=b and br.tenant_id=member.tenant_id and br.active)) then raise exception 'invalid_branch_access'; end if;
  update public.staff_invitations set status='expired',updated_at=now() where tenant_id=member.tenant_id and lower(email)=normalized and status='pending' and expires_at<=now();
  insert into public.staff_invitations(id,tenant_id,email,role,branch_ids,invited_by)
  values(invitation_id,member.tenant_id,normalized,target_role,target_branch_ids,actor);
  return invitation_id;
end; $$;

create or replace function public.accept_staff_invitation()
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); actor_email text:=lower(coalesce((select auth.jwt()->>'email'),'')); invitation public.staff_invitations%rowtype; new_membership_id uuid;
begin
  select * into invitation from public.staff_invitations where lower(email)=actor_email and status='pending' and expires_at>now() order by created_at desc limit 1 for update;
  if invitation.id is null then raise exception 'invitation_not_found'; end if;
  insert into public.memberships(tenant_id,user_id,role,active) values(invitation.tenant_id,actor,invitation.role,true)
  on conflict(tenant_id,user_id) do update set role=excluded.role,active=true,updated_at=now() returning id into new_membership_id;
  delete from public.membership_branches mb where mb.tenant_id=invitation.tenant_id and mb.membership_id=new_membership_id;
  insert into public.membership_branches(tenant_id,membership_id,branch_id)
  select invitation.tenant_id,new_membership_id,invited_branch_id from unnest(invitation.branch_ids) invited_branch_id;
  update public.staff_invitations set status='accepted',accepted_by=actor,updated_at=now() where id=invitation.id;
  return jsonb_build_object('tenantId',invitation.tenant_id,'role',invitation.role,'branchIds',invitation.branch_ids);
end; $$;

create or replace function public.revoke_staff_access(target_membership_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); owner_member public.memberships%rowtype; target public.memberships%rowtype;
begin
  select * into target from public.memberships where id=target_membership_id for update;
  select * into owner_member from public.memberships where tenant_id=target.tenant_id and user_id=actor and active and role='owner' limit 1;
  if owner_member.id is null or target.id is null or target.role='owner' then raise exception 'invalid_staff_target'; end if;
  update public.memberships set active=false,updated_at=now() where id=target.id;
  update public.devices set status='revoked',updated_at=now() where tenant_id=target.tenant_id and id in (
    select device_id from public.audit_events where tenant_id=target.tenant_id and actor_id=target.user_id and device_id is not null
  );
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result)
  values(target.tenant_id,actor,'staff.revoke','membership',target.id::text,'success');
end; $$;

create or replace function public.set_device_unlock_pin(target_device_id uuid, pin text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); member public.memberships%rowtype;
begin
  select m.* into member from public.memberships m join public.devices d on d.tenant_id=m.tenant_id and d.id=target_device_id
  where m.user_id=actor and m.active and d.status='active' limit 1;
  if member.id is null or pin!~'^[0-9]{6}$' then raise exception 'invalid_pin'; end if;
  insert into public.staff_device_pins(tenant_id,user_id,device_id,pin_hash)
  values(member.tenant_id,actor,target_device_id,crypt(pin,gen_salt('bf',10)))
  on conflict(tenant_id,user_id,device_id) do update set pin_hash=excluded.pin_hash,failed_attempts=0,locked_until=null,updated_at=now();
end; $$;

create or replace function public.verify_device_unlock_pin(target_device_id uuid, pin text)
returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); record public.staff_device_pins%rowtype; valid boolean;
begin
  select * into record from public.staff_device_pins where user_id=actor and device_id=target_device_id for update;
  if record.user_id is null or (record.locked_until is not null and record.locked_until>now()) then return false; end if;
  valid:=record.pin_hash=crypt(pin,record.pin_hash);
  if valid then update public.staff_device_pins set failed_attempts=0,locked_until=null,updated_at=now() where tenant_id=record.tenant_id and user_id=actor and device_id=target_device_id;
  else update public.staff_device_pins set failed_attempts=failed_attempts+1,locked_until=case when failed_attempts+1>=5 then now()+interval '15 minutes' else locked_until end,updated_at=now() where tenant_id=record.tenant_id and user_id=actor and device_id=target_device_id; end if;
  return valid;
end; $$;

create or replace function public.verify_receipt(receipt_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'valid',true,'saleId',r.sale_id,'receiptNumber',r.receipt_number,'businessName',b.name,
    'branchName',br.name,'totalMinor',r.total_minor,'paymentMethod',r.payment_method,'occurredAt',r.occurred_at,
    'status',s.status
  ) from public.receipt_verifications r join public.sales s on s.id=r.sale_id and s.tenant_id=r.tenant_id
  join public.businesses b on b.id=s.business_id and b.tenant_id=s.tenant_id
  join public.branches br on br.id=s.branch_id and br.tenant_id=s.tenant_id
  where r.sale_id=receipt_id;
$$;

create or replace function public.admin_model_b_snapshot()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.is_platform_admin() then raise exception 'platform_admin_required'; end if;
  return jsonb_build_object(
    'wallets',coalesce((select jsonb_agg(jsonb_build_object('tenantId',w.tenant_id,'tenantName',t.name,'pendingMinor',w.pending_minor,'availableMinor',w.available_minor,'reserveMinor',w.reserve_minor,'lockedMinor',w.withdrawal_locked_minor,'updatedAt',w.updated_at) order by w.updated_at desc) from public.merchant_wallets w join public.tenants t on t.id=w.tenant_id),'[]'::jsonb),
    'withdrawals',coalesce((select jsonb_agg(jsonb_build_object('id',wr.id,'tenantId',wr.tenant_id,'tenantName',t.name,'accountId',a.id,'amountMinor',wr.amount_minor,'status',wr.status,'bankCode',a.bank_code,'accountHolder',a.account_holder,'accountLast4',a.account_last4,'kycStatus',a.kyc_status,'createdAt',wr.created_at,'externalReference',wr.external_reference) order by wr.created_at desc) from public.withdrawal_requests wr join public.tenants t on t.id=wr.tenant_id join public.withdrawal_accounts a on a.id=wr.account_id and a.tenant_id=wr.tenant_id),'[]'::jsonb),
    'metrics',jsonb_build_object(
      'pendingWalletMinor',coalesce((select sum(pending_minor) from public.merchant_wallets),0),
      'availableWalletMinor',coalesce((select sum(available_minor) from public.merchant_wallets),0),
      'reserveMinor',coalesce((select sum(reserve_minor) from public.merchant_wallets),0),
      'withdrawalsWaiting',coalesce((select count(*) from public.withdrawal_requests where status in ('requested','approved')),0)
    )
  );
end; $$;

-- Replaces the earlier QRIS creator so discounts and the normalized item list
-- used by Core API are calculated by the trusted database, not by the APK.
create or replace function public.create_qris_sale(
  sale_id uuid, target_branch_id uuid, client_device_id uuid, customer_id uuid,
  receipt_number text, lines jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); member public.memberships%rowtype; branch public.branches%rowtype;
  requested jsonb; product public.products%rowtype; quantity numeric(18,4); discount bigint;
  gross bigint; taxable bigint; line_tax bigint; line_total bigint; subtotal bigint:=0; discount_total bigint:=0; tax_total bigint:=0;
  provider_items jsonb:='[]'::jsonb;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  if jsonb_typeof(lines)<>'array' or jsonb_array_length(lines)=0 or jsonb_array_length(lines)>200 then raise exception 'invalid_lines'; end if;
  select * into branch from public.branches where id=target_branch_id and active;
  if branch.id is null then raise exception 'branch_not_found'; end if;
  select * into member from public.memberships where tenant_id=branch.tenant_id and user_id=actor and active limit 1;
  if member.id is null then raise exception 'tenant_access_denied'; end if;
  if not exists(select 1 from public.membership_branches mb where mb.tenant_id=branch.tenant_id and mb.membership_id=member.id and mb.branch_id=branch.id) and member.role<>'owner' then raise exception 'branch_access_denied'; end if;
  if not exists(select 1 from public.devices d where d.id=client_device_id and d.tenant_id=branch.tenant_id and d.branch_id=branch.id and d.status='active') then raise exception 'device_not_active'; end if;
  if not exists(select 1 from public.merchant_verifications mv where mv.tenant_id=branch.tenant_id and mv.status='approved' and mv.qris_enabled) then raise exception 'qris_not_enabled'; end if;
  for requested in select value from jsonb_array_elements(lines) loop
    quantity:=(requested->>'quantity')::numeric;
    if quantity<=0 then raise exception 'invalid_quantity'; end if;
    select * into product from public.products where id=(requested->>'productId')::uuid and tenant_id=branch.tenant_id and business_id=branch.business_id and active for share;
    if product.id is null then raise exception 'product_not_found'; end if;
    gross:=round(product.price_minor*quantity);
    discount:=greatest(0,least(gross,coalesce((requested->>'discountMinor')::bigint,0)));
    if member.role='cashier' and discount>round(gross*.10) then raise exception 'cashier_discount_limit'; end if;
    taxable:=gross-discount; line_tax:=round(taxable*product.tax_rate/100); line_total:=taxable+line_tax;
    subtotal:=subtotal+gross; discount_total:=discount_total+discount; tax_total:=tax_total+line_tax;
    provider_items:=provider_items||jsonb_build_array(jsonb_build_object(
      'id',product.id::text,'price',round(line_total/quantity),'quantity',quantity,'name',left(product.name,50)
    ));
  end loop;
  insert into public.sales(id,tenant_id,business_id,branch_id,device_id,cashier_id,customer_id,receipt_number,status,
    subtotal_minor,discount_minor,tax_minor,total_minor,paid_minor,payment_method,version,occurred_at)
  values(sale_id,branch.tenant_id,branch.business_id,branch.id,client_device_id,actor,customer_id,receipt_number,'pending_payment',subtotal,discount_total,tax_total,subtotal-discount_total+tax_total,0,'qris',1,now());
  for requested in select value from jsonb_array_elements(lines) loop
    quantity:=(requested->>'quantity')::numeric;
    select * into product from public.products where id=(requested->>'productId')::uuid and tenant_id=branch.tenant_id;
    gross:=round(product.price_minor*quantity); discount:=greatest(0,least(gross,coalesce((requested->>'discountMinor')::bigint,0)));
    line_tax:=round((gross-discount)*product.tax_rate/100); line_total:=gross-discount+line_tax;
    insert into public.sale_items(tenant_id,sale_id,product_id,name,quantity,price_minor,cost_minor,discount_minor,tax_minor,total_minor)
    values(branch.tenant_id,sale_id,product.id,product.name,quantity,product.price_minor,product.cost_minor,discount,line_tax,line_total);
  end loop;
  insert into public.payments(tenant_id,sale_id,method,amount_minor,provider,provider_reference,provider_status)
  values(branch.tenant_id,sale_id,'qris',subtotal-discount_total+tax_total,'midtrans',sale_id::text,'pending');
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result)
  values(branch.tenant_id,actor,client_device_id,'payment.qris.create','sale',sale_id::text,'success');
  return jsonb_build_object('saleId',sale_id,'tenantId',branch.tenant_id,'orderId',sale_id::text,'receiptNumber',receipt_number,
    'amount',subtotal-discount_total+tax_total,'currency','IDR','items',provider_items);
end; $$;

insert into public.wallet_policies(tenant_id) select id from public.tenants on conflict(tenant_id) do nothing;
insert into public.merchant_wallets(tenant_id) select id from public.tenants on conflict(tenant_id) do nothing;

revoke all on function private.wallet_post(uuid,text,text,uuid,text,bigint,bigint,bigint,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.release_due_wallet_settlements(integer) from public,anon,authenticated;
grant execute on function public.release_due_wallet_settlements(integer) to service_role,authenticated;
revoke all on function public.release_due_wallet_reserves(integer) from public,anon,authenticated;
grant execute on function public.release_due_wallet_reserves(integer) to service_role,authenticated;
revoke all on function public.request_withdrawal(uuid,bigint) from public,anon;
grant execute on function public.request_withdrawal(uuid,bigint) to authenticated;
revoke all on function public.admin_review_withdrawal(uuid,text,text,text) from public,anon;
grant execute on function public.admin_review_withdrawal(uuid,text,text,text) to authenticated;
revoke all on function public.create_staff_invitation(text,public.membership_role,uuid[]) from public,anon;
grant execute on function public.create_staff_invitation(text,public.membership_role,uuid[]) to authenticated;
revoke all on function public.accept_staff_invitation() from public,anon;
grant execute on function public.accept_staff_invitation() to authenticated;
revoke all on function public.revoke_staff_access(uuid) from public,anon;
grant execute on function public.revoke_staff_access(uuid) to authenticated;
revoke all on function public.set_device_unlock_pin(uuid,text) from public,anon;
grant execute on function public.set_device_unlock_pin(uuid,text) to authenticated;
revoke all on function public.verify_device_unlock_pin(uuid,text) from public,anon;
grant execute on function public.verify_device_unlock_pin(uuid,text) to authenticated;
revoke all on function public.verify_receipt(uuid) from public;
grant execute on function public.verify_receipt(uuid) to anon,authenticated;
revoke all on function public.admin_model_b_snapshot() from public,anon;
grant execute on function public.admin_model_b_snapshot() to authenticated;
revoke all on function public.create_qris_sale(uuid,uuid,uuid,uuid,text,jsonb) from public;
grant execute on function public.create_qris_sale(uuid,uuid,uuid,uuid,text,jsonb) to authenticated;

commit;
