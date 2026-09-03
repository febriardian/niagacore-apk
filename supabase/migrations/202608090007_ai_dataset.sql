begin;

create or replace function public.get_ai_business_dataset(target_tenant_id uuid, target_branch_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not private.is_tenant_member(target_tenant_id) then null else jsonb_build_object(
    'windowDays',30,'generatedAt',now(),
    'sales',coalesce((select jsonb_build_object('count',count(*),'revenueMinor',coalesce(sum(total_minor),0))
      from public.sales where tenant_id=target_tenant_id and branch_id=target_branch_id and status='paid'
        and occurred_at>=now()-interval '30 days'),'{}'::jsonb),
    'products',coalesce((select jsonb_agg(jsonb_build_object('name',p.name,'sku',p.sku,'stock',coalesce(m.stock,0),
      'priceMinor',p.price_minor)) from public.products p left join lateral
      (select sum(quantity) stock from public.inventory_movements where tenant_id=p.tenant_id and product_id=p.id and branch_id=target_branch_id) m on true
      where p.tenant_id=target_tenant_id and p.active limit 100),'[]'::jsonb)
  ) end;
$$;

revoke all on function public.get_ai_business_dataset(uuid,uuid) from public;
grant execute on function public.get_ai_business_dataset(uuid,uuid) to authenticated;

commit;
