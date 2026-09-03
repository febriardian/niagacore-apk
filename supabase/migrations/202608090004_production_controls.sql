begin;

create type public.merchant_verification_status as enum ('pending','approved','rejected','suspended');

create table public.merchant_verifications (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  owner_name text not null check (char_length(owner_name) between 2 and 120),
  owner_phone text,
  business_name text not null check (char_length(business_name) between 2 and 160),
  business_address text,
  status public.merchant_verification_status not null default 'pending',
  qris_enabled boolean not null default false,
  review_note text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  check (not qris_enabled or status = 'approved')
);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id) on delete restrict,
  actor_id uuid references auth.users(id),
  device_id uuid,
  action text not null,
  resource_type text not null,
  resource_id text,
  result text not null check (result in ('success','denied','failed')),
  reason text,
  correlation_id uuid not null default gen_random_uuid(),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table public.ai_usage (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  feature text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);

create index audit_events_tenant_time_idx on public.audit_events(tenant_id, occurred_at desc);
create index ai_usage_tenant_time_idx on public.ai_usage(tenant_id, created_at desc);

create or replace function private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.platform_admins where user_id = (select auth.uid()) and active);
$$;

revoke all on function private.is_platform_admin() from public;
grant execute on function private.is_platform_admin() to authenticated;

alter table public.merchant_verifications enable row level security;
alter table public.platform_admins enable row level security;
alter table public.audit_events enable row level security;
alter table public.ai_usage enable row level security;

create policy merchant_verification_member_read on public.merchant_verifications
  for select to authenticated using (private.is_tenant_member(tenant_id));
create policy merchant_verification_owner_update on public.merchant_verifications
  for update to authenticated using (
    exists(select 1 from public.memberships m where m.tenant_id = merchant_verifications.tenant_id
      and m.user_id = (select auth.uid()) and m.role = 'owner' and m.active)
  ) with check (status = 'pending' and not qris_enabled);
create policy merchant_verification_admin_all on public.merchant_verifications
  for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy platform_admin_self_read on public.platform_admins
  for select to authenticated using (user_id = (select auth.uid()));
create policy audit_member_read on public.audit_events
  for select to authenticated using (tenant_id is not null and private.is_tenant_member(tenant_id));
create policy ai_usage_member_read on public.ai_usage
  for select to authenticated using (private.is_tenant_member(tenant_id));

-- Replace onboarding so an unverified e-mail cannot create a tenant and every
-- merchant starts in the explicit review queue. All operational features except
-- QRIS remain available while status is pending.
create or replace function public.bootstrap_owner(
  display_name text, tenant_name text, tenant_slug text, business_name text,
  enabled_modules text[], branch_name text, branch_code text, device_id uuid,
  device_label text, preferred_language text default 'id'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := (select auth.uid());
  new_tenant_id uuid; new_business_id uuid; new_branch_id uuid; new_membership_id uuid; safe_slug text;
begin
  if actor_id is null then raise exception 'authentication_required'; end if;
  if not exists(select 1 from auth.users where id = actor_id and email_confirmed_at is not null) then
    raise exception 'email_not_verified';
  end if;
  if exists(select 1 from public.memberships where user_id = actor_id and active) then raise exception 'user_already_onboarded'; end if;
  if char_length(trim(display_name)) < 2 or char_length(trim(tenant_name)) < 2
    or char_length(trim(business_name)) < 2 or char_length(trim(branch_name)) < 2 then raise exception 'invalid_onboarding_name'; end if;
  if preferred_language not in ('id','en') then raise exception 'invalid_language'; end if;
  if branch_code !~ '^[A-Z0-9_-]{2,20}$' then raise exception 'invalid_branch_code'; end if;
  if enabled_modules is null or cardinality(enabled_modules) = 0
    or not (enabled_modules <@ array['retail','food_service','services','wholesale']::text[]) then raise exception 'invalid_business_modules'; end if;

  safe_slug := left(tenant_slug,48) || '-' || substr(replace(gen_random_uuid()::text,'-',''),1,8);
  insert into public.profiles(id,display_name,preferred_language) values(actor_id,trim(display_name),preferred_language)
    on conflict(id) do update set display_name=excluded.display_name, preferred_language=excluded.preferred_language, updated_at=now();
  insert into public.tenants(name,slug,default_language,created_by) values(trim(tenant_name),safe_slug,preferred_language,actor_id) returning id into new_tenant_id;
  insert into public.businesses(tenant_id,name,modules) values(new_tenant_id,trim(business_name),enabled_modules) returning id into new_business_id;
  insert into public.branches(tenant_id,business_id,name,code) values(new_tenant_id,new_business_id,trim(branch_name),branch_code) returning id into new_branch_id;
  insert into public.memberships(tenant_id,user_id,role) values(new_tenant_id,actor_id,'owner') returning id into new_membership_id;
  insert into public.membership_branches(tenant_id,membership_id,branch_id) values(new_tenant_id,new_membership_id,new_branch_id);
  insert into public.devices(id,tenant_id,branch_id,label,status,last_seen_at) values(device_id,new_tenant_id,new_branch_id,trim(device_label),'active',now());
  insert into public.merchant_verifications(tenant_id,owner_name,business_name) values(new_tenant_id,trim(display_name),trim(business_name));
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result)
    values(new_tenant_id,actor_id,device_id,'merchant.register','tenant',new_tenant_id::text,'success');
  return jsonb_build_object('tenantId',new_tenant_id,'businessId',new_business_id,'branchId',new_branch_id,
    'deviceId',device_id,'userId',actor_id,'role','owner','merchantStatus','pending','qrisEnabled',false);
end; $$;

-- Admin approval is server enforced and audited. QRIS cannot be enabled for a
-- merchant that has not been approved.
create or replace function public.review_merchant(target_tenant_id uuid, decision text, note text default null, enable_qris boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'admin_required'; end if;
  if decision not in ('approved','rejected','suspended') then raise exception 'invalid_decision'; end if;
  if enable_qris and decision <> 'approved' then raise exception 'qris_requires_approval'; end if;
  update public.merchant_verifications set status=decision::public.merchant_verification_status,
    qris_enabled=enable_qris, review_note=nullif(trim(note),''), reviewed_at=now(), reviewed_by=(select auth.uid()), updated_at=now()
  where tenant_id=target_tenant_id;
  if not found then raise exception 'merchant_not_found'; end if;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,reason)
    values(target_tenant_id,(select auth.uid()),'merchant.review','tenant',target_tenant_id::text,'success',decision);
end; $$;

revoke all on function public.review_merchant(uuid,text,text,boolean) from public;
grant execute on function public.review_merchant(uuid,text,text,boolean) to authenticated;

commit;
