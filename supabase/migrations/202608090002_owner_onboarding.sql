begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 120),
  preferred_language text not null default 'id' check (preferred_language in ('id', 'en')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy profiles_select_self on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy profiles_update_self on public.profiles
  for update to authenticated using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create or replace function public.bootstrap_owner(
  display_name text,
  tenant_name text,
  tenant_slug text,
  business_name text,
  enabled_modules text[],
  branch_name text,
  branch_code text,
  device_id uuid,
  device_label text,
  preferred_language text default 'id'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  new_tenant_id uuid;
  new_business_id uuid;
  new_branch_id uuid;
  new_membership_id uuid;
  safe_slug text;
begin
  if actor_id is null then raise exception 'authentication_required'; end if;
  if exists (select 1 from public.memberships where user_id = actor_id and active) then
    raise exception 'user_already_onboarded';
  end if;
  if char_length(trim(display_name)) < 2 or char_length(trim(tenant_name)) < 2
     or char_length(trim(business_name)) < 2 or char_length(trim(branch_name)) < 2 then
    raise exception 'invalid_onboarding_name';
  end if;
  if preferred_language not in ('id', 'en') then raise exception 'invalid_language'; end if;
  if branch_code !~ '^[A-Z0-9_-]{2,20}$' then raise exception 'invalid_branch_code'; end if;
  if enabled_modules is null or cardinality(enabled_modules) = 0
     or not (enabled_modules <@ array['retail','food_service','services','wholesale']::text[]) then
    raise exception 'invalid_business_modules';
  end if;

  safe_slug := left(tenant_slug, 48) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.profiles (id, display_name, preferred_language)
  values (actor_id, trim(display_name), preferred_language)
  on conflict (id) do update set
    display_name = excluded.display_name,
    preferred_language = excluded.preferred_language,
    updated_at = now();

  insert into public.tenants (name, slug, default_language, created_by)
  values (trim(tenant_name), safe_slug, preferred_language, actor_id)
  returning id into new_tenant_id;

  insert into public.businesses (tenant_id, name, modules)
  values (new_tenant_id, trim(business_name), enabled_modules)
  returning id into new_business_id;

  insert into public.branches (tenant_id, business_id, name, code)
  values (new_tenant_id, new_business_id, trim(branch_name), branch_code)
  returning id into new_branch_id;

  insert into public.memberships (tenant_id, user_id, role)
  values (new_tenant_id, actor_id, 'owner')
  returning id into new_membership_id;

  insert into public.membership_branches (tenant_id, membership_id, branch_id)
  values (new_tenant_id, new_membership_id, new_branch_id);

  insert into public.devices (id, tenant_id, branch_id, label, status, last_seen_at)
  values (device_id, new_tenant_id, new_branch_id, trim(device_label), 'active', now());

  return jsonb_build_object(
    'tenantId', new_tenant_id,
    'businessId', new_business_id,
    'branchId', new_branch_id,
    'deviceId', device_id,
    'userId', actor_id,
    'role', 'owner'
  );
end;
$$;

revoke all on function public.bootstrap_owner(text,text,text,text,text[],text,text,uuid,text,text) from public;
grant execute on function public.bootstrap_owner(text,text,text,text,text[],text,text,uuid,text,text) to authenticated;

commit;
