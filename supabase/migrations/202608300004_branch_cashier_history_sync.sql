begin;

-- Kasir melihat ringkasan operasional seluruh cabang aktif agar jumlah transaksi
-- dan omzet konsisten dengan pemilik pada cabang dan periode yang sama. Data
-- sensitif pemilik seperti HPP, beban, laba, dan utang usaha tidak dikembalikan.
create or replace function public.get_cashier_dashboard(target_branch_id uuid,period_days integer default 7)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  actor uuid:=(select auth.uid()); tenant uuid; days integer:=least(greatest(period_days,1),90);
  today date:=(timezone('Asia/Jakarta',now()))::date; start_date date; previous_start date;
  gross_sales bigint; transaction_total integer; average_ticket bigint;
  previous_gross bigint; receivable_total bigint; result jsonb;
begin
  select b.tenant_id into tenant from public.branches b where b.id=target_branch_id and b.active;
  if actor is null or tenant is null or not exists(
    select 1 from public.memberships m
    where m.tenant_id=tenant and m.user_id=actor and m.active and m.role='cashier'
      and exists(select 1 from public.membership_branches mb
        where mb.tenant_id=m.tenant_id and mb.membership_id=m.id and mb.branch_id=target_branch_id)
  ) then raise exception 'cashier_branch_access_denied'; end if;

  start_date:=today-(days-1); previous_start:=start_date-days;

  select coalesce(sum(s.total_minor),0)::bigint,count(*)::integer,
    coalesce(round(avg(s.total_minor)),0)::bigint
  into gross_sales,transaction_total,average_ticket
  from public.sales s
  where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid'
    and timezone('Asia/Jakarta',s.occurred_at)::date between start_date and today;

  select coalesce(sum(s.total_minor),0)::bigint into previous_gross
  from public.sales s
  where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid'
    and timezone('Asia/Jakarta',s.occurred_at)::date between previous_start and start_date-1;

  select coalesce(sum(greatest(s.total_minor-s.paid_minor,0)),0)::bigint into receivable_total
  from public.sales s
  where s.tenant_id=tenant and s.branch_id=target_branch_id
    and s.status='paid' and s.payment_method='credit' and s.total_minor>s.paid_minor;

  with current_sales as (
    select s.* from public.sales s
    where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid'
      and timezone('Asia/Jakarta',s.occurred_at)::date between start_date and today
  ), daily as (
    select d::date label,coalesce(sum(s.total_minor),0)::bigint amount_minor,count(s.id)::integer transactions
    from generate_series(start_date,today,interval '1 day') d
    left join current_sales s on timezone('Asia/Jakarta',s.occurred_at)::date=d::date
    group by d order by d
  ), received_payments as (
    select p.method::text method,sum(p.amount_minor)::bigint amount_minor
    from public.payments p join public.sales s on s.id=p.sale_id and s.tenant_id=p.tenant_id
    where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid'
      and p.provider_status='settled'
      and timezone('Asia/Jakarta',p.paid_at)::date between start_date and today
    group by p.method
  ), payment_mix as (
    select method,amount_minor from received_payments where amount_minor>0
    union all select 'receivable',receivable_total where receivable_total>0
  ) select jsonb_build_object(
    'dailySales',coalesce((select jsonb_agg(jsonb_build_object('label',label,'amountMinor',amount_minor,'transactions',transactions) order by label) from daily),'[]'::jsonb),
    'topProducts','[]'::jsonb,
    'paymentMix',coalesce((select jsonb_agg(jsonb_build_object('method',method,'amountMinor',amount_minor)) from payment_mix),'[]'::jsonb),
    'grossSalesMinor',gross_sales,'costMinor',0,'expenseMinor',0,'profitMinor',0,
    'receivableMinor',receivable_total,'payableMinor',0,'lowStockCount',0,
    'previousGrossSalesMinor',previous_gross,'transactionCount',transaction_total,
    'averageTicketMinor',average_ticket
  ) into result;
  return result;
end $$;

revoke all on function public.get_cashier_dashboard(uuid,integer) from public,anon;
grant execute on function public.get_cashier_dashboard(uuid,integer) to authenticated;
notify pgrst, 'reload schema';

commit;
