begin;

-- A new accounting period preserves immutable history, but excludes older rows
-- from the default dashboard summaries and charts.
-- Tenants that never explicitly started a new period keep their original period.
update public.tenants t
set current_period_started_at=p.started_at
from public.merchant_operating_periods p
where p.tenant_id=t.id and p.ended_at is null
  and not exists(
    select 1 from public.merchant_lifecycle_events e
    where e.tenant_id=t.id and e.action='start_period'
  );

create or replace function public.get_branch_dashboard(target_branch_id uuid,period_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  tenant uuid; days integer:=least(greatest(period_days,1),90);
  today date:=(timezone('Asia/Jakarta',now()))::date; start_date date; previous_start date;
  period_started_at timestamptz; period_start_date date;
  gross_sales bigint; transaction_total integer; average_ticket bigint; tax_total bigint;
  cost_total bigint; expense_total bigint; receivable_total bigint; payable_total bigint;
  previous_gross bigint; low_stock_total bigint; result jsonb;
begin
  select b.tenant_id,t.current_period_started_at into tenant,period_started_at
  from public.branches b join public.tenants t on t.id=b.tenant_id
  where b.id=target_branch_id and b.active;
  if tenant is null or not exists(
    select 1 from public.memberships m where m.tenant_id=tenant and m.user_id=(select auth.uid()) and m.active
      and (m.role in ('owner','business_manager') or exists(select 1 from public.membership_branches mb where mb.tenant_id=m.tenant_id and mb.membership_id=m.id and mb.branch_id=target_branch_id))
  ) then raise exception 'branch_access_denied'; end if;
  period_start_date:=(timezone('Asia/Jakarta',period_started_at))::date;
  start_date:=greatest(today-(days-1),period_start_date); previous_start:=greatest(start_date-days,period_start_date);

  select coalesce(sum(s.total_minor),0)::bigint,count(*)::integer,coalesce(round(avg(s.total_minor)),0)::bigint,coalesce(sum(s.tax_minor),0)::bigint
  into gross_sales,transaction_total,average_ticket,tax_total from public.sales s
  where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid' and s.occurred_at>=period_started_at
    and timezone('Asia/Jakarta',s.occurred_at)::date between start_date and today;
  select coalesce(round(sum(i.quantity*i.cost_minor)),0)::bigint into cost_total
  from public.sale_items i join public.sales s on s.id=i.sale_id and s.tenant_id=i.tenant_id
  where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid' and s.occurred_at>=period_started_at
    and timezone('Asia/Jakarta',s.occurred_at)::date between start_date and today;
  select coalesce(sum(r.amount_minor),0)::bigint into expense_total from public.business_records r
  where r.tenant_id=tenant and r.branch_id=target_branch_id and r.kind='expense' and r.status='posted' and r.updated_at>=period_started_at
    and timezone('Asia/Jakarta',r.updated_at)::date between start_date and today;
  select coalesce(sum(d.original_minor-d.settled_minor) filter(where d.document_type='receivable' and d.status not in('paid','settled')),0)::bigint,
    coalesce(sum(d.original_minor-d.settled_minor) filter(where d.document_type='payable' and d.status not in('paid','settled')),0)::bigint
  into receivable_total,payable_total from public.subledger_documents d where d.tenant_id=tenant and d.branch_id=target_branch_id;
  select coalesce(sum(s.total_minor),0)::bigint into previous_gross from public.sales s
  where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid' and s.occurred_at>=period_started_at
    and timezone('Asia/Jakarta',s.occurred_at)::date between previous_start and start_date-1;
  with stock as (
    select p.id,p.track_stock,coalesce((p.metadata->>'minimumStock')::numeric,0) minimum_stock,coalesce(sum(m.quantity),0) quantity
    from public.products p left join public.inventory_movements m on m.tenant_id=p.tenant_id and m.product_id=p.id and m.branch_id=target_branch_id
    where p.tenant_id=tenant and p.active group by p.id,p.track_stock,p.metadata
  ) select count(*)::bigint into low_stock_total from stock where track_stock and quantity<=minimum_stock;
  with current_sales as (
    select s.* from public.sales s where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid' and s.occurred_at>=period_started_at
      and timezone('Asia/Jakarta',s.occurred_at)::date between start_date and today
  ), daily as (
    select d::date label,coalesce(sum(s.total_minor),0)::bigint amount_minor,count(s.id)::integer transactions
    from generate_series(start_date,today,interval '1 day') d left join current_sales s on timezone('Asia/Jakarta',s.occurred_at)::date=d::date group by d order by d
  ), top_products as (
    select i.name,sum(i.quantity)::numeric quantity,sum(i.total_minor)::bigint revenue_minor from public.sale_items i join current_sales s on s.id=i.sale_id and s.tenant_id=i.tenant_id group by i.product_id,i.name order by revenue_minor desc limit 5
  ), payment_components as (
    select case when s.payment_method='credit' then 'cash' else s.payment_method::text end method,case when s.payment_method='credit' then s.paid_minor else s.total_minor end::bigint amount_minor from current_sales s
    union all select 'receivable',greatest(s.total_minor-s.paid_minor,0)::bigint from current_sales s where s.payment_method='credit' and s.total_minor>s.paid_minor
  ), payment_mix as (
    select method,sum(amount_minor)::bigint amount_minor from payment_components where amount_minor>0 group by method order by amount_minor desc
  ) select jsonb_build_object(
    'dailySales',coalesce((select jsonb_agg(jsonb_build_object('label',label,'amountMinor',amount_minor,'transactions',transactions) order by label) from daily),'[]'::jsonb),
    'topProducts',coalesce((select jsonb_agg(jsonb_build_object('name',name,'quantity',quantity,'revenueMinor',revenue_minor)) from top_products),'[]'::jsonb),
    'paymentMix',coalesce((select jsonb_agg(jsonb_build_object('method',method,'amountMinor',amount_minor)) from payment_mix),'[]'::jsonb),
    'grossSalesMinor',gross_sales,'costMinor',cost_total,'expenseMinor',expense_total,'profitMinor',gross_sales-tax_total-cost_total-expense_total,
    'receivableMinor',receivable_total,'payableMinor',payable_total,'lowStockCount',low_stock_total,'previousGrossSalesMinor',previous_gross,
    'transactionCount',transaction_total,'averageTicketMinor',average_ticket,'currentPeriodStartedAt',period_started_at
  ) into result; return result;
end $$;

create or replace function public.get_cashier_dashboard(target_branch_id uuid,period_days integer default 7)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  actor uuid:=(select auth.uid()); tenant uuid; days integer:=least(greatest(period_days,1),90);
  today date:=(timezone('Asia/Jakarta',now()))::date; start_date date; previous_start date;
  period_started_at timestamptz; period_start_date date;
  gross_sales bigint; transaction_total integer; average_ticket bigint; previous_gross bigint; receivable_total bigint; result jsonb;
begin
  select b.tenant_id,t.current_period_started_at into tenant,period_started_at from public.branches b join public.tenants t on t.id=b.tenant_id where b.id=target_branch_id and b.active;
  if actor is null or tenant is null or not exists(
    select 1 from public.memberships m where m.tenant_id=tenant and m.user_id=actor and m.active and m.role='cashier'
      and exists(select 1 from public.membership_branches mb where mb.tenant_id=m.tenant_id and mb.membership_id=m.id and mb.branch_id=target_branch_id)
  ) then raise exception 'cashier_branch_access_denied'; end if;
  period_start_date:=(timezone('Asia/Jakarta',period_started_at))::date;
  start_date:=greatest(today-(days-1),period_start_date); previous_start:=greatest(start_date-days,period_start_date);
  select coalesce(sum(s.total_minor),0)::bigint,count(*)::integer,coalesce(round(avg(s.total_minor)),0)::bigint into gross_sales,transaction_total,average_ticket
  from public.sales s where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid' and s.occurred_at>=period_started_at
    and timezone('Asia/Jakarta',s.occurred_at)::date between start_date and today;
  select coalesce(sum(s.total_minor),0)::bigint into previous_gross from public.sales s
  where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid' and s.occurred_at>=period_started_at
    and timezone('Asia/Jakarta',s.occurred_at)::date between previous_start and start_date-1;
  select coalesce(sum(greatest(s.total_minor-s.paid_minor,0)),0)::bigint into receivable_total from public.sales s
  where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid' and s.payment_method='credit' and s.total_minor>s.paid_minor;
  with current_sales as (
    select s.* from public.sales s where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid' and s.occurred_at>=period_started_at
      and timezone('Asia/Jakarta',s.occurred_at)::date between start_date and today
  ), daily as (
    select d::date label,coalesce(sum(s.total_minor),0)::bigint amount_minor,count(s.id)::integer transactions
    from generate_series(start_date,today,interval '1 day') d left join current_sales s on timezone('Asia/Jakarta',s.occurred_at)::date=d::date group by d order by d
  ), received_payments as (
    select p.method::text method,sum(p.amount_minor)::bigint amount_minor from public.payments p join public.sales s on s.id=p.sale_id and s.tenant_id=p.tenant_id
    where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid' and p.paid_at>=period_started_at
      and timezone('Asia/Jakarta',p.paid_at)::date between start_date and today group by p.method
  ), payment_mix as (
    select method,amount_minor from received_payments where amount_minor>0 union all select 'receivable',receivable_total where receivable_total>0
  ) select jsonb_build_object(
    'dailySales',coalesce((select jsonb_agg(jsonb_build_object('label',label,'amountMinor',amount_minor,'transactions',transactions) order by label) from daily),'[]'::jsonb),
    'topProducts','[]'::jsonb,'paymentMix',coalesce((select jsonb_agg(jsonb_build_object('method',method,'amountMinor',amount_minor)) from payment_mix),'[]'::jsonb),
    'grossSalesMinor',gross_sales,'costMinor',0,'expenseMinor',0,'profitMinor',0,'receivableMinor',receivable_total,'payableMinor',0,'lowStockCount',0,
    'previousGrossSalesMinor',previous_gross,'transactionCount',transaction_total,'averageTicketMinor',average_ticket,'currentPeriodStartedAt',period_started_at
  ) into result; return result;
end $$;

revoke all on function public.get_branch_dashboard(uuid,integer) from public,anon;
revoke all on function public.get_cashier_dashboard(uuid,integer) from public,anon;
grant execute on function public.get_branch_dashboard(uuid,integer) to authenticated;
grant execute on function public.get_cashier_dashboard(uuid,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
