begin;

drop function if exists public.reserve_ai_request(uuid,text,text);
create or replace function public.reserve_ai_request(target_tenant_id uuid, target_business_id uuid, feature_name text, model_name text)
returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid := (select auth.uid()); recent_count integer;
begin
  if actor is null or not private.is_tenant_member(target_tenant_id) then return false; end if;
  if not exists(select 1 from public.accounting_settings where tenant_id=target_tenant_id and business_id=target_business_id and cloud_ai_enabled) then return false; end if;
  select count(*) into recent_count from public.ai_usage where tenant_id=target_tenant_id and actor_id=actor and created_at>now()-interval '1 minute';
  if recent_count>=12 then return false; end if;
  insert into public.ai_usage(tenant_id,actor_id,feature,model) values(target_tenant_id,actor,left(feature_name,80),left(model_name,120));
  return true;
end; $$;
revoke all on function public.reserve_ai_request(uuid,uuid,text,text) from public;
grant execute on function public.reserve_ai_request(uuid,uuid,text,text) to authenticated;

create or replace function public.get_ai_business_dataset(target_tenant_id uuid,target_branch_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select case when not private.is_tenant_member(target_tenant_id) then null else jsonb_build_object(
    'windowDays',90,'generatedAt',now(),'currency','IDR',
    'sales',coalesce((select jsonb_build_object('count',count(*),'revenueMinor',coalesce(sum(total_minor),0),'averageTicketMinor',coalesce(round(avg(total_minor)),0),'refundCount',count(*) filter(where status='refunded')) from public.sales where tenant_id=target_tenant_id and branch_id=target_branch_id and occurred_at>=now()-interval '90 days'),'{}'::jsonb),
    'salesByDay',coalesce((select jsonb_agg(x order by x->>'date') from (select jsonb_build_object('date',occurred_at::date,'revenueMinor',sum(total_minor),'transactions',count(*)) x from public.sales where tenant_id=target_tenant_id and branch_id=target_branch_id and status='paid' and occurred_at>=now()-interval '90 days' group by occurred_at::date) q),'[]'::jsonb),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'sku',p.sku,'stock',coalesce(m.stock,0),'priceMinor',p.price_minor,'costMinor',p.cost_minor)) from public.products p left join lateral(select sum(quantity) stock from public.inventory_movements where tenant_id=p.tenant_id and product_id=p.id and branch_id=target_branch_id)m on true where p.tenant_id=target_tenant_id and p.active limit 250),'[]'::jsonb),
    'topProducts',coalesce((select jsonb_agg(x order by (x->>'revenueMinor')::bigint desc) from (select jsonb_build_object('name',i.name,'quantity',sum(i.quantity),'revenueMinor',sum(i.total_minor))x from public.sale_items i join public.sales s on s.id=i.sale_id and s.tenant_id=i.tenant_id where s.tenant_id=target_tenant_id and s.branch_id=target_branch_id and s.occurred_at>=now()-interval '90 days' group by i.product_id,i.name limit 20)q),'[]'::jsonb),
    'openReceivablesMinor',coalesce((select sum(amount_minor) from public.business_records where tenant_id=target_tenant_id and branch_id=target_branch_id and kind='receivable' and active and status not in ('paid','settled')),0),
    'openPayablesMinor',coalesce((select sum(amount_minor) from public.business_records where tenant_id=target_tenant_id and branch_id=target_branch_id and kind='payable' and active and status not in ('paid','settled')),0),
    'expensesMinor',coalesce((select sum(amount_minor) from public.business_records where tenant_id=target_tenant_id and branch_id=target_branch_id and kind='expense' and active and created_at>=now()-interval '90 days'),0),
    'anomalies',jsonb_build_object('negativeStockProducts',coalesce((select count(*) from public.products p left join lateral(select sum(quantity) stock from public.inventory_movements where tenant_id=p.tenant_id and product_id=p.id and branch_id=target_branch_id)m on true where p.tenant_id=target_tenant_id and p.active and coalesce(m.stock,0)<0),0),'pendingSyncReview',0)
  ) end;
$$;
revoke all on function public.get_ai_business_dataset(uuid,uuid) from public;
grant execute on function public.get_ai_business_dataset(uuid,uuid) to authenticated;

commit;
