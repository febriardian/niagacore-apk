begin;

-- Recreate both reporting RPCs so production no longer depends on executing a
-- helper in the private schema. The caller is checked directly against active
-- membership and branch grants before any business data is read.
create or replace function public.get_branch_dashboard(target_branch_id uuid, period_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare tenant uuid; days integer:=least(greatest(period_days,1),90); today date:=(timezone('Asia/Jakarta',now()))::date; start_date date; previous_start date; result jsonb;
begin
  select b.tenant_id into tenant from public.branches b where b.id=target_branch_id and b.active;
  if tenant is null or not exists(
    select 1 from public.memberships m
    where m.tenant_id=tenant and m.user_id=(select auth.uid()) and m.active
      and (m.role in ('owner','business_manager') or exists(
        select 1 from public.membership_branches mb
        where mb.tenant_id=m.tenant_id and mb.membership_id=m.id and mb.branch_id=target_branch_id
      ))
  ) then raise exception 'branch_access_denied'; end if;
  start_date:=today-(days-1); previous_start:=start_date-days;
  with paid as (
    select s.* from public.sales s where s.tenant_id=tenant and s.branch_id=target_branch_id and s.status='paid'
  ), current_sales as (
    select * from paid where timezone('Asia/Jakarta',occurred_at)::date between start_date and today
  ), daily as (
    select d::date label,coalesce(sum(s.total_minor),0)::bigint amount_minor,count(s.id)::integer transactions
    from generate_series(start_date,today,interval '1 day') d left join current_sales s on timezone('Asia/Jakarta',s.occurred_at)::date=d::date group by d order by d
  ), top_products as (
    select i.name,sum(i.quantity)::numeric quantity,sum(i.total_minor)::bigint revenue_minor from public.sale_items i join current_sales s on s.id=i.sale_id and s.tenant_id=i.tenant_id group by i.product_id,i.name order by revenue_minor desc limit 5
  ), payment_mix as (
    select payment_method::text method,sum(total_minor)::bigint amount_minor from current_sales group by payment_method order by amount_minor desc
  ), stock as (
    select p.id,p.cost_minor,p.track_stock,coalesce((p.metadata->>'minimumStock')::numeric,0) minimum_stock,coalesce(sum(m.quantity),0) quantity
    from public.products p left join public.inventory_movements m on m.tenant_id=p.tenant_id and m.product_id=p.id and m.branch_id=target_branch_id
    where p.tenant_id=tenant and p.active group by p.id,p.cost_minor,p.track_stock,p.metadata
  )
  select jsonb_build_object(
    'dailySales',coalesce((select jsonb_agg(jsonb_build_object('label',label,'amountMinor',amount_minor,'transactions',transactions) order by label) from daily),'[]'::jsonb),
    'topProducts',coalesce((select jsonb_agg(jsonb_build_object('name',name,'quantity',quantity,'revenueMinor',revenue_minor)) from top_products),'[]'::jsonb),
    'paymentMix',coalesce((select jsonb_agg(jsonb_build_object('method',method,'amountMinor',amount_minor)) from payment_mix),'[]'::jsonb),
    'grossSalesMinor',coalesce((select sum(total_minor) from current_sales),0),'costMinor',coalesce((select sum(i.quantity*i.cost_minor) from public.sale_items i join current_sales s on s.id=i.sale_id and s.tenant_id=i.tenant_id),0),
    'expenseMinor',coalesce((select sum(amount_minor) from public.business_records where tenant_id=tenant and branch_id=target_branch_id and kind='expense' and status='posted' and timezone('Asia/Jakarta',updated_at)::date between start_date and today),0),
    'receivableMinor',coalesce((select sum(original_minor-settled_minor) from public.subledger_documents where tenant_id=tenant and branch_id=target_branch_id and document_type='receivable' and status not in('paid','settled')),0),
    'payableMinor',coalesce((select sum(original_minor-settled_minor) from public.subledger_documents where tenant_id=tenant and branch_id=target_branch_id and document_type='payable' and status not in('paid','settled')),0),
    'lowStockCount',coalesce((select count(*) from stock where track_stock and quantity<=minimum_stock),0),
    'previousGrossSalesMinor',coalesce((select sum(total_minor) from paid where timezone('Asia/Jakarta',occurred_at)::date between previous_start and start_date-1),0),
    'transactionCount',(select count(*) from current_sales),'averageTicketMinor',coalesce((select round(avg(total_minor)) from current_sales),0)
  ) into result;
  return result||jsonb_build_object('profitMinor',(result->>'grossSalesMinor')::bigint
    -coalesce((select sum(tax_minor) from public.sales where tenant_id=tenant and branch_id=target_branch_id and status='paid' and timezone('Asia/Jakarta',occurred_at)::date between start_date and today),0)
    -(result->>'costMinor')::bigint-(result->>'expenseMinor')::bigint);
end $$;

create or replace function public.get_branch_management_report(target_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare tenant uuid; today date:=(timezone('Asia/Jakarta',now()))::date; result jsonb;
begin
  select b.tenant_id into tenant from public.branches b where b.id=target_branch_id and b.active;
  if tenant is null or not exists(
    select 1 from public.memberships m
    where m.tenant_id=tenant and m.user_id=(select auth.uid()) and m.active
      and (m.role in ('owner','business_manager') or exists(
        select 1 from public.membership_branches mb
        where mb.tenant_id=m.tenant_id and mb.membership_id=m.id and mb.branch_id=target_branch_id
      ))
  ) then raise exception 'branch_access_denied'; end if;
  with document_types(document_type) as (values ('receivable'::text),('payable'::text)), documents as (
    select document_type,original_minor-settled_minor outstanding,due_at from public.subledger_documents where tenant_id=tenant and branch_id=target_branch_id and original_minor>settled_minor
  ), aging as (
    select t.document_type,
      coalesce(sum(d.outstanding) filter(where d.due_at is null or d.due_at>=today),0)::bigint current_minor,
      coalesce(sum(d.outstanding) filter(where d.due_at between today-30 and today-1),0)::bigint days30_minor,
      coalesce(sum(d.outstanding) filter(where d.due_at between today-60 and today-31),0)::bigint days60_minor,
      coalesce(sum(d.outstanding) filter(where d.due_at<today-60),0)::bigint over90_minor from document_types t left join documents d using(document_type) group by t.document_type
  ), stock as (
    select p.id,p.cost_minor,coalesce(sum(m.quantity),0) quantity from public.products p left join public.inventory_movements m on m.tenant_id=p.tenant_id and m.product_id=p.id and m.branch_id=target_branch_id where p.tenant_id=tenant and p.active group by p.id,p.cost_minor
  )
  select jsonb_build_object(
    'cashInMinor',coalesce((select sum(total_minor) from public.sales where tenant_id=tenant and branch_id=target_branch_id and status='paid'),0)
      +coalesce((select sum(settled_minor) from public.subledger_documents where tenant_id=tenant and branch_id=target_branch_id and document_type='receivable'),0),
    'cashOutMinor',coalesce((select sum(amount_minor) from public.business_records where tenant_id=tenant and branch_id=target_branch_id and kind='expense' and status='posted'),0)
      +coalesce((select sum(settled_minor) from public.subledger_documents where tenant_id=tenant and branch_id=target_branch_id and document_type='payable'),0),
    'inventoryValueMinor',coalesce((select sum(greatest(quantity,0)*cost_minor) from stock),0),
    'outputTaxMinor',coalesce((select sum(tax_minor) from public.sales where tenant_id=tenant and branch_id=target_branch_id and status='paid'),0),
    'inputTaxMinor',coalesce((select sum(coalesce(nullif(metadata->>'taxMinor','')::bigint,0)) from public.business_records where tenant_id=tenant and branch_id=target_branch_id and kind in('supplier_bill','expense') and status='posted'),0),
    'aging',coalesce((select jsonb_agg(jsonb_build_object('kind',case document_type when 'receivable' then 'Piutang' else 'Utang' end,'currentMinor',current_minor,'days30Minor',days30_minor,'days60Minor',days60_minor,'over90Minor',over90_minor)) from aging),'[]'::jsonb)
  ) into result;
  return result;
end $$;

revoke all on function public.get_branch_dashboard(uuid,integer) from public,anon;
grant execute on function public.get_branch_dashboard(uuid,integer) to authenticated;
revoke all on function public.get_branch_management_report(uuid) from public,anon;
grant execute on function public.get_branch_management_report(uuid) to authenticated;

commit;
