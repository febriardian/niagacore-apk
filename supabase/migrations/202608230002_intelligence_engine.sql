begin;

create extension if not exists vector with schema extensions;

create table public.nia_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null,
  branch_id uuid,
  title text not null check (char_length(trim(title)) between 3 and 160),
  content text not null check (char_length(trim(content)) between 20 and 12000),
  content_hash text not null,
  embedding extensions.vector(768) not null,
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id,business_id) references public.businesses(tenant_id,id),
  foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
  unique (tenant_id,content_hash),
  unique (tenant_id,id)
);

create index nia_knowledge_scope_idx
  on public.nia_knowledge_documents(tenant_id,business_id,branch_id,active,updated_at desc);
create index nia_knowledge_embedding_idx
  on public.nia_knowledge_documents using hnsw (embedding extensions.vector_cosine_ops);

alter table public.nia_knowledge_documents enable row level security;
create policy nia_knowledge_select_member on public.nia_knowledge_documents
for select to authenticated using (
  private.is_tenant_member(tenant_id)
  and (branch_id is null or private.can_access_branch(tenant_id,branch_id))
);

create or replace function public.match_nia_knowledge(
  target_tenant_id uuid,
  target_business_id uuid,
  target_branch_id uuid,
  query_embedding extensions.vector(768),
  match_count integer default 5
)
returns table(id uuid,title text,content text,metadata jsonb,similarity double precision)
language sql stable security definer set search_path='' as $$
  select d.id,d.title,d.content,d.metadata,
    (1-(d.embedding OPERATOR(extensions.<=>) query_embedding))::double precision similarity
  from public.nia_knowledge_documents d
  where d.tenant_id=target_tenant_id
    and d.business_id=target_business_id
    and d.active
    and (d.branch_id is null or d.branch_id=target_branch_id)
    and private.can_access_branch(target_tenant_id,target_branch_id)
  order by d.embedding OPERATOR(extensions.<=>) query_embedding
  limit greatest(1,least(coalesce(match_count,5),8));
$$;

revoke all on function public.match_nia_knowledge(uuid,uuid,uuid,extensions.vector,integer) from public;
grant execute on function public.match_nia_knowledge(uuid,uuid,uuid,extensions.vector,integer) to authenticated;

create or replace function public.get_ai_business_dataset(
  target_tenant_id uuid,
  target_branch_id uuid,
  target_window_days integer
)
returns jsonb language sql stable security definer set search_path='' as $$
with parameters as (
  select greatest(7,least(coalesce(target_window_days,90),365))::integer as window_days
), scoped_sales as (
  select s.* from public.sales s,parameters p
  where s.tenant_id=target_tenant_id and s.branch_id=target_branch_id
    and s.occurred_at>=now()-(p.window_days*interval '1 day')
), paid_sales as (
  select * from scoped_sales where status='paid'
), sales_by_day(sale_date,revenue_minor,transactions) as (
  select timezone('Asia/Jakarta',occurred_at)::date,
    sum(total_minor)::bigint,count(*)::bigint
  from paid_sales
  group by timezone('Asia/Jakarta',occurred_at)::date
), stock as (
  select p.id,p.name,p.sku,p.price_minor,p.cost_minor,p.track_stock,
    case when coalesce(p.metadata->>'minimumStock','') ~ '^[-+]?[0-9]+([.][0-9]+)?$'
      then (p.metadata->>'minimumStock')::numeric else 0 end minimum_stock,
    greatest(1,case when coalesce(p.metadata->>'leadTimeDays','') ~ '^[0-9]+$'
      then (p.metadata->>'leadTimeDays')::integer else 7 end) lead_time_days,
    coalesce(sum(m.quantity),0)::numeric quantity
  from public.products p
  left join public.inventory_movements m on m.tenant_id=p.tenant_id and m.product_id=p.id and m.branch_id=target_branch_id
  where p.tenant_id=target_tenant_id and p.business_id=(select business_id from public.branches where id=target_branch_id and tenant_id=target_tenant_id) and p.active
  group by p.id,p.name,p.sku,p.price_minor,p.cost_minor,p.track_stock,p.metadata
), demand(product_id,sale_date,quantity) as (
  select i.product_id,timezone('Asia/Jakarta',s.occurred_at)::date,sum(i.quantity)::numeric
  from public.sale_items i join paid_sales s on s.id=i.sale_id and s.tenant_id=i.tenant_id
  group by i.product_id,timezone('Asia/Jakarta',s.occurred_at)::date
), customer_rfm as (
  select s.customer_id,
    greatest(0,(current_date-max(timezone('Asia/Jakarta',s.occurred_at)::date)))::integer recency_days,
    count(*)::integer frequency,
    sum(s.total_minor)::bigint monetary_minor
  from paid_sales s where s.customer_id is not null group by s.customer_id
), refund_totals as (
  select count(*)::bigint refund_count,coalesce(sum(r.amount_minor),0)::bigint refund_minor
  from public.refunds r,parameters p
  where r.tenant_id=target_tenant_id and r.branch_id=target_branch_id and r.status='posted'
    and r.occurred_at>=now()-(p.window_days*interval '1 day')
), margin_sales as (
  select s.id,s.total_minor,coalesce(sum(i.cost_minor*i.quantity),0)::numeric cost_minor
  from paid_sales s left join public.sale_items i on i.tenant_id=s.tenant_id and i.sale_id=s.id group by s.id,s.total_minor
), duplicates as (
  select count(*)::bigint groups_count from (
    select cashier_id,total_minor,date_trunc('minute',occurred_at),count(*)
    from paid_sales
    group by cashier_id,total_minor,date_trunc('minute',occurred_at)
    having count(*)>1
  ) q
), customer_scored as (
  select case
    when recency_days<=30 and frequency>=5 and monetary_minor>=1000000 then 'champion'
    when recency_days<=60 and frequency>=3 then 'loyal'
    when recency_days<=30 then 'promising'
    when recency_days<=120 and frequency>=2 then 'at_risk'
    else 'hibernating' end as segment
  from customer_rfm
), customer_segments as (
  select segment,count(*)::bigint as customers
  from customer_scored
  group by segment
)
select case when not private.can_access_branch(target_tenant_id,target_branch_id) then null else jsonb_build_object(
  'windowDays',(select window_days from parameters),'generatedAt',now(),'currency','IDR',
  'sales',jsonb_build_object(
    'count',(select count(*) from paid_sales),
    'revenueMinor',coalesce((select sum(total_minor) from paid_sales),0),
    'averageTicketMinor',coalesce((select round(avg(total_minor)) from paid_sales),0),
    'discountMinor',coalesce((select sum(discount_minor) from paid_sales),0),
    'refundCount',(select refund_count from refund_totals),
    'refundMinor',(select refund_minor from refund_totals)
  ),
  'salesByDay',coalesce((select jsonb_agg(jsonb_build_object('date',sale_date,'revenueMinor',revenue_minor,'transactions',transactions) order by sale_date) from sales_by_day),'[]'::jsonb),
  'products',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'sku',sku,'stock',quantity,'minimumStock',minimum_stock,'leadTimeDays',lead_time_days,'priceMinor',price_minor,'costMinor',cost_minor,'trackStock',track_stock) order by name) from stock),'[]'::jsonb),
  'productDemand',coalesce((select jsonb_agg(jsonb_build_object('productId',product_id,'date',sale_date,'quantity',quantity) order by product_id,sale_date) from demand),'[]'::jsonb),
  'customerRfm',coalesce((select jsonb_agg(jsonb_build_object('recencyDays',recency_days,'frequency',frequency,'monetaryMinor',monetary_minor)) from customer_rfm),'[]'::jsonb),
  'customerSegments',coalesce((select jsonb_object_agg(segment,customers) from customer_segments),'{}'::jsonb),
  'openReceivablesMinor',coalesce((select sum(amount_minor) from public.business_records where tenant_id=target_tenant_id and branch_id=target_branch_id and kind='receivable' and active and status not in ('paid','settled')),0),
  'openPayablesMinor',coalesce((select sum(amount_minor) from public.business_records where tenant_id=target_tenant_id and branch_id=target_branch_id and kind='payable' and active and status not in ('paid','settled')),0),
  'expensesMinor',coalesce((select sum(b.amount_minor) from public.business_records b,parameters p where b.tenant_id=target_tenant_id and b.branch_id=target_branch_id and b.kind='expense' and b.active and b.created_at>=now()-(p.window_days*interval '1 day')),0),
  'anomalyMetrics',jsonb_build_object(
    'negativeStockProducts',(select count(*) from stock where track_stock and quantity<0),
    'lowStockProducts',(select count(*) from stock where track_stock and quantity<=minimum_stock),
    'negativeMarginTransactions',(select count(*) from margin_sales where cost_minor>total_minor),
    'highDiscountTransactions',(select count(*) from paid_sales where subtotal_minor>0 and discount_minor::numeric/subtotal_minor>.20),
    'refundRatio',case when coalesce((select sum(total_minor) from paid_sales),0)>0 then (select refund_minor from refund_totals)::numeric/(select sum(total_minor) from paid_sales) else 0 end,
    'cashVarianceMinor',coalesce((select sum(abs(variance_minor)) from public.shifts sh,parameters p where sh.tenant_id=target_tenant_id and sh.branch_id=target_branch_id and sh.status='closed' and sh.closed_at>=now()-(p.window_days*interval '1 day')),0),
    'possibleDuplicateGroups',(select groups_count from duplicates)
  )
) end;
$$;

create or replace function public.get_ai_business_dataset(target_tenant_id uuid,target_branch_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select public.get_ai_business_dataset(target_tenant_id,target_branch_id,90);
$$;

revoke all on function public.get_ai_business_dataset(uuid,uuid,integer) from public;
revoke all on function public.get_ai_business_dataset(uuid,uuid) from public;
grant execute on function public.get_ai_business_dataset(uuid,uuid,integer) to authenticated;
grant execute on function public.get_ai_business_dataset(uuid,uuid) to authenticated;

comment on table public.nia_knowledge_documents is 'Tenant-scoped, permission-aware knowledge used only as retrieved context for NIA.';
comment on function public.get_ai_business_dataset(uuid,uuid,integer) is 'Deterministic analytics input; generative providers must not recalculate these values.';

commit;
