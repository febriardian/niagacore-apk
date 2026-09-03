begin;

-- Production-normalized records for domains that previously depended on
-- business_records.metadata. Generic records remain the mutation/event source;
-- these tables provide typed, constrained projections for reporting/integrity.
create table public.product_variants(id uuid primary key,tenant_id uuid not null,business_id uuid not null,product_id uuid not null references public.products(id),name text not null,sku text not null,price_minor bigint not null check(price_minor>=0),active boolean not null default true,unique(tenant_id,sku));
create table public.product_units(id uuid primary key,tenant_id uuid not null,product_id uuid not null references public.products(id),code text not null,conversion numeric(18,6) not null check(conversion>0),is_base boolean not null default false,unique(product_id,code));
create table public.product_barcodes(id uuid primary key,tenant_id uuid not null,product_id uuid not null references public.products(id),variant_id uuid references public.product_variants(id),barcode text not null,format text not null,unique(tenant_id,barcode));
create table public.warehouses(id uuid primary key,tenant_id uuid not null,business_id uuid not null,branch_id uuid not null,name text not null,active boolean not null default true,unique(branch_id,name));
create table public.stock_counts(id uuid primary key,tenant_id uuid not null,branch_id uuid not null,warehouse_id uuid references public.warehouses(id),status text not null check(status in('draft','counting','submitted','posted','cancelled')),occurred_at timestamptz not null,posted_at timestamptz);
create table public.stock_count_lines(stock_count_id uuid not null references public.stock_counts(id),tenant_id uuid not null,product_id uuid not null references public.products(id),system_quantity numeric(18,4) not null,counted_quantity numeric(18,4) not null,primary key(stock_count_id,product_id));
create table public.stock_transfers(id uuid primary key,tenant_id uuid not null,source_branch_id uuid not null,destination_branch_id uuid not null,status text not null check(status in('draft','approved','in_transit','received','cancelled')),occurred_at timestamptz not null,check(source_branch_id<>destination_branch_id));
create table public.stock_transfer_lines(stock_transfer_id uuid not null references public.stock_transfers(id),tenant_id uuid not null,product_id uuid not null references public.products(id),quantity numeric(18,4) not null check(quantity>0),primary key(stock_transfer_id,product_id));
create table public.purchase_orders(id uuid primary key,tenant_id uuid not null,business_id uuid not null,branch_id uuid not null,supplier_id uuid,document_number text not null,status text not null check(status in('draft','submitted','approved','partially_received','received','cancelled')),ordered_at timestamptz not null,expected_at date,total_minor bigint not null default 0 check(total_minor>=0),unique(branch_id,document_number));
create table public.purchase_order_lines(purchase_order_id uuid not null references public.purchase_orders(id),tenant_id uuid not null,product_id uuid not null references public.products(id),quantity numeric(18,4) not null check(quantity>0),unit_cost_minor bigint not null check(unit_cost_minor>=0),tax_minor bigint not null default 0 check(tax_minor>=0),primary key(purchase_order_id,product_id));
create table public.goods_receipts(id uuid primary key,tenant_id uuid not null,branch_id uuid not null,purchase_order_id uuid references public.purchase_orders(id),document_number text not null,status text not null check(status in('draft','checked','posted','cancelled')),received_at timestamptz not null,unique(branch_id,document_number));
create table public.goods_receipt_lines(goods_receipt_id uuid not null references public.goods_receipts(id),tenant_id uuid not null,product_id uuid not null references public.products(id),quantity numeric(18,4) not null check(quantity>0),lot_code text,expires_at date,unit_cost_minor bigint not null check(unit_cost_minor>=0),primary key(goods_receipt_id,product_id));
create table public.loyalty_events(id uuid primary key,tenant_id uuid not null,customer_id uuid not null references public.customers(id),event_type text not null check(event_type in('earn','redeem','expire','adjust')),points integer not null check(points<>0),reference_type text not null,reference_id uuid not null,occurred_at timestamptz not null,unique(tenant_id,reference_type,reference_id,event_type));
create table public.consent_records(id uuid primary key,tenant_id uuid not null,customer_id uuid not null references public.customers(id),purpose text not null,status text not null check(status in('granted','withdrawn')),source text not null,occurred_at timestamptz not null);
create table public.service_catalog(id uuid primary key,tenant_id uuid not null,business_id uuid not null,name text not null,duration_minutes integer not null check(duration_minutes>0),price_minor bigint not null check(price_minor>=0),active boolean not null default true);
create table public.kitchen_orders(id uuid primary key,tenant_id uuid not null,branch_id uuid not null,sale_id uuid references public.sales(id),table_label text,status text not null check(status in('queued','preparing','ready','served','cancelled')),notes text,created_at timestamptz not null,updated_at timestamptz not null);
create table public.modifier_options(id uuid primary key,tenant_id uuid not null,business_id uuid not null,name text not null,price_delta_minor bigint not null default 0,active boolean not null default true);

do $$ declare t text; begin
  foreach t in array array['product_variants','product_units','product_barcodes','warehouses','stock_counts','stock_count_lines','stock_transfers','stock_transfer_lines','purchase_orders','purchase_order_lines','goods_receipts','goods_receipt_lines','loyalty_events','consent_records','service_catalog','kitchen_orders','modifier_options'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create policy %I on public.%I for select to authenticated using(private.is_tenant_member(tenant_id))','read_'||t,t);
  end loop;
end $$;

commit;
