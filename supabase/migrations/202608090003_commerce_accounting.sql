begin;

create type public.sale_status as enum ('draft','pending_payment','paid','void','refunded');
create type public.payment_method as enum ('cash','qris','transfer','card','credit');
create type public.stock_movement_type as enum ('opening','purchase','sale','return_in','return_out','adjustment','transfer_in','transfer_out','waste');

create table public.products (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null, sku text not null, barcode text, name text not null, category text not null default 'Umum',
  price_minor bigint not null check(price_minor >= 0), cost_minor bigint not null default 0 check(cost_minor >= 0),
  unit text not null default 'pcs', tax_rate numeric(5,2) not null default 0 check(tax_rate between 0 and 100),
  active boolean not null default true, version bigint not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(tenant_id,business_id) references public.businesses(tenant_id,id), unique(tenant_id,sku), unique(tenant_id,barcode), unique(tenant_id,id)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, phone text, email text, points bigint not null default 0, balance_minor bigint not null default 0,
  version bigint not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,id)
);

create table public.sales (
  id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, business_id uuid not null,
  branch_id uuid not null, device_id uuid not null, cashier_id uuid not null references auth.users(id), customer_id uuid,
  receipt_number text not null, status public.sale_status not null, subtotal_minor bigint not null, discount_minor bigint not null default 0,
  tax_minor bigint not null default 0, total_minor bigint not null, paid_minor bigint not null default 0,
  payment_method public.payment_method not null, version bigint not null default 0, occurred_at timestamptz not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(tenant_id,business_id) references public.businesses(tenant_id,id), foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  foreign key(tenant_id,device_id) references public.devices(tenant_id,id), foreign key(tenant_id,customer_id) references public.customers(tenant_id,id),
  unique(tenant_id,receipt_number), unique(tenant_id,id)
);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid not null, product_id uuid not null, name text not null, quantity numeric(18,4) not null check(quantity > 0),
  price_minor bigint not null, cost_minor bigint not null default 0, discount_minor bigint not null default 0,
  tax_minor bigint not null default 0, total_minor bigint not null,
  foreign key(tenant_id,sale_id) references public.sales(tenant_id,id) on delete cascade,
  foreign key(tenant_id,product_id) references public.products(tenant_id,id), unique(tenant_id,id)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid not null, method public.payment_method not null, amount_minor bigint not null check(amount_minor > 0),
  provider text, provider_reference text, provider_status text, metadata jsonb not null default '{}'::jsonb,
  paid_at timestamptz, created_at timestamptz not null default now(),
  foreign key(tenant_id,sale_id) references public.sales(tenant_id,id), unique(provider,provider_reference), unique(tenant_id,id)
);

create table public.inventory_movements (
  sequence_id bigint generated always as identity primary key, id uuid not null default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade, branch_id uuid not null, product_id uuid not null,
  movement_type public.stock_movement_type not null, quantity numeric(18,4) not null check(quantity <> 0),
  unit_cost_minor bigint, reference_type text not null, reference_id uuid not null, occurred_at timestamptz not null,
  created_at timestamptz not null default now(), foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  foreign key(tenant_id,product_id) references public.products(tenant_id,id), unique(tenant_id,id)
);

create table public.partners (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check(kind in ('supplier','customer','both')), name text not null, phone text, email text, address text, tax_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,id)
);

create table public.purchases (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null, supplier_id uuid, invoice_number text, status text not null check(status in ('draft','ordered','received','cancelled')),
  total_minor bigint not null, paid_minor bigint not null default 0, due_at date, occurred_at timestamptz not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id), foreign key(tenant_id,supplier_id) references public.partners(tenant_id,id), unique(tenant_id,id)
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null, category text not null, description text not null, amount_minor bigint not null check(amount_minor > 0),
  payment_source text not null check(payment_source in ('cash','bank','payable')), occurred_at timestamptz not null,
  created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id), unique(tenant_id,id)
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null, code text not null, name text not null, account_type text not null,
  normal_balance text not null check(normal_balance in ('debit','credit')), active boolean not null default true,
  foreign key(tenant_id,business_id) references public.businesses(tenant_id,id), unique(business_id,code), unique(tenant_id,id)
);

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null, source_type text not null, source_id uuid not null, memo text not null,
  status text not null default 'posted' check(status in ('draft','posted','reversed')), occurred_at timestamptz not null,
  posted_by uuid references auth.users(id), created_at timestamptz not null default now(),
  foreign key(tenant_id,business_id) references public.businesses(tenant_id,id), unique(tenant_id,source_type,source_id), unique(tenant_id,id)
);

create table public.journal_lines (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  entry_id uuid not null, account_code text not null, debit_minor bigint not null default 0 check(debit_minor >= 0),
  credit_minor bigint not null default 0 check(credit_minor >= 0), description text,
  foreign key(tenant_id,entry_id) references public.journal_entries(tenant_id,id) on delete cascade,
  check((debit_minor > 0 and credit_minor = 0) or (credit_minor > 0 and debit_minor = 0))
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null, customer_id uuid, service_name text not null, staff_name text, starts_at timestamptz not null,
  duration_minutes integer not null check(duration_minutes > 0), status text not null, notes text,
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id), foreign key(tenant_id,customer_id) references public.customers(tenant_id,id), unique(tenant_id,id)
);

create table public.dining_tables (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null, code text not null, capacity integer not null check(capacity > 0), status text not null,
  active_sale_id uuid, foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  foreign key(tenant_id,active_sale_id) references public.sales(tenant_id,id), unique(branch_id,code), unique(tenant_id,id)
);

create table public.ai_insights (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid, kind text not null, title text not null, summary text not null, severity text not null,
  payload jsonb not null default '{}'::jsonb, status text not null default 'new', generated_at timestamptz not null default now(),
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id), unique(tenant_id,id)
);

create index products_tenant_business_idx on public.products(tenant_id,business_id,active);
create index sales_tenant_branch_date_idx on public.sales(tenant_id,branch_id,occurred_at desc);
create index inventory_tenant_product_idx on public.inventory_movements(tenant_id,branch_id,product_id,sequence_id);
create index journal_tenant_date_idx on public.journal_entries(tenant_id,business_id,occurred_at);

do $$ declare t text; begin
  foreach t in array array['products','customers','sales','sale_items','payments','inventory_movements','partners','purchases','expenses','accounts','journal_entries','journal_lines','appointments','dining_tables','ai_insights'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.is_tenant_member(tenant_id))', t || '_select_member', t);
  end loop;
end $$;

comment on table public.inventory_movements is 'Append-only stock ledger; current stock is derived from movements.';
comment on table public.journal_entries is 'Posted entries are immutable; corrections use reversing entries.';
commit;
