begin;

create extension if not exists pgcrypto;
create schema if not exists private;

create type public.membership_role as enum ('owner', 'supervisor', 'cashier');
create type public.device_status as enum ('pending', 'active', 'revoked');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  default_language text not null default 'id' check (default_language in ('id', 'en')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 160),
  currency text not null default 'IDR' check (currency = 'IDR'),
  timezone text not null default 'Asia/Jakarta' check (timezone = 'Asia/Jakarta'),
  modules text[] not null default array['retail']::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null,
  name text not null check (char_length(name) between 2 and 160),
  code text not null check (code ~ '^[A-Z0-9_-]{2,20}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, business_id) references public.businesses(tenant_id, id) on delete cascade,
  unique (business_id, code),
  unique (tenant_id, id)
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.membership_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id),
  unique (tenant_id, id)
);

create table public.membership_branches (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  membership_id uuid not null,
  branch_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (membership_id, branch_id),
  foreign key (tenant_id, membership_id) references public.memberships(tenant_id, id) on delete cascade,
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id) on delete cascade
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null,
  label text not null check (char_length(label) between 2 and 120),
  public_key text,
  status public.device_status not null default 'pending',
  last_seen_at timestamptz,
  sync_cursor bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id) on delete restrict,
  unique (tenant_id, id)
);

create table public.sync_mutations (
  sequence_id bigint generated always as identity primary key,
  mutation_id uuid not null unique,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null,
  branch_id uuid not null,
  device_id uuid not null,
  actor_id uuid not null references auth.users(id),
  idempotency_key text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  operation text not null check (operation in ('create', 'update', 'archive')),
  base_version bigint,
  schema_version integer not null default 1,
  payload jsonb not null,
  occurred_at timestamptz not null,
  accepted_at timestamptz not null default now(),
  foreign key (tenant_id, business_id) references public.businesses(tenant_id, id),
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id),
  foreign key (tenant_id, device_id) references public.devices(tenant_id, id),
  unique (tenant_id, idempotency_key)
);

create index memberships_user_tenant_idx on public.memberships (user_id, tenant_id) where active;
create index branches_tenant_idx on public.branches (tenant_id);
create index devices_tenant_branch_idx on public.devices (tenant_id, branch_id);
create index sync_mutations_tenant_sequence_idx on public.sync_mutations (tenant_id, sequence_id);

create or replace function private.is_tenant_member(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.memberships m
     where m.tenant_id = target_tenant_id
       and m.user_id = (select auth.uid())
       and m.active
  );
$$;

revoke all on function private.is_tenant_member(uuid) from public;
grant execute on function private.is_tenant_member(uuid) to authenticated;

alter table public.tenants enable row level security;
alter table public.businesses enable row level security;
alter table public.branches enable row level security;
alter table public.memberships enable row level security;
alter table public.membership_branches enable row level security;
alter table public.devices enable row level security;
alter table public.sync_mutations enable row level security;

create policy tenants_select_member on public.tenants
  for select to authenticated using (private.is_tenant_member(id));

create policy businesses_select_member on public.businesses
  for select to authenticated using (private.is_tenant_member(tenant_id));

create policy branches_select_member on public.branches
  for select to authenticated using (private.is_tenant_member(tenant_id));

create policy memberships_select_self on public.memberships
  for select to authenticated using (user_id = (select auth.uid()));

create policy membership_branches_select_member on public.membership_branches
  for select to authenticated using (private.is_tenant_member(tenant_id));

create policy devices_select_member on public.devices
  for select to authenticated using (private.is_tenant_member(tenant_id));

create policy sync_mutations_select_member on public.sync_mutations
  for select to authenticated using (private.is_tenant_member(tenant_id));

comment on table public.sync_mutations is
  'Append-only accepted mutation log. Writes are performed by the sync service after authorization and idempotency checks.';

commit;
