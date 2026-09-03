begin;

alter table public.sales add column if not exists shift_id uuid;
alter table public.sales drop constraint if exists sales_shift_fk;
alter table public.sales add constraint sales_shift_fk
  foreign key(tenant_id,shift_id) references public.shifts(tenant_id,id);

create or replace function private.link_sale_shift_from_sync()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.aggregate_type='sale' and nullif(new.payload->>'shiftId','') is not null then
    update public.sales set shift_id=(new.payload->>'shiftId')::uuid
    where tenant_id=new.tenant_id and id=new.aggregate_id
      and exists(select 1 from public.shifts s where s.tenant_id=new.tenant_id and s.id=(new.payload->>'shiftId')::uuid and s.branch_id=new.branch_id);
  end if;
  return new;
end $$;
drop trigger if exists sync_sale_shift_link on public.sync_mutations;
create trigger sync_sale_shift_link after insert on public.sync_mutations for each row execute function private.link_sale_shift_from_sync();

create or replace function private.can_read_sync_aggregate(target_tenant uuid, aggregate_name text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare role_name public.membership_role;
begin
  role_name:=private.current_role(target_tenant);
  if role_name in ('owner','business_manager') then return true; end if;
  if aggregate_name in ('manual_journal','fiscal_period','tax','asset','accounting_settings') then
    return role_name in ('finance','auditor');
  elsif aggregate_name in ('purchase_order','goods_receipt','supplier_bill','purchase_return','payable','supplier') then
    return role_name in ('branch_manager','supervisor','purchasing','warehouse','finance','auditor');
  elsif aggregate_name in ('stock_count','stock_transfer','stock_adjustment','lot','product','price_list','bundle','recipe','modifier') then
    return role_name in ('branch_manager','supervisor','warehouse','purchasing','kitchen','auditor');
  elsif aggregate_name in ('sale','shift','cash_movement','refund','customer','receivable','loyalty','customer_segment') then
    return role_name in ('branch_manager','supervisor','cashier','finance','service_staff','waiter','auditor');
  elsif aggregate_name in ('appointment','service') then
    return role_name in ('branch_manager','supervisor','service_staff','auditor');
  elsif aggregate_name in ('dining_table','kitchen_order') then
    return role_name in ('branch_manager','supervisor','kitchen','waiter','auditor');
  end if;
  return false;
end $$;

drop policy if exists sync_mutations_select_scoped on public.sync_mutations;
drop policy if exists sync_mutations_select_member on public.sync_mutations;
create policy sync_mutations_select_permission on public.sync_mutations
for select to authenticated using(
  private.can_access_branch(tenant_id,branch_id)
  and private.can_read_sync_aggregate(tenant_id,aggregate_type)
  and (
    private.current_role(tenant_id) not in ('cashier','waiter','service_staff')
    or aggregate_type not in ('sale','shift','cash_movement','refund')
    or actor_id=(select auth.uid())
  )
);

create or replace function private.enforce_sync_scope()
returns trigger language plpgsql security definer set search_path='' as $$
declare actor_role public.membership_role;
begin
  if coalesce(auth.role(),'')='service_role' then return new; end if;
  if not private.can_access_branch(new.tenant_id,new.branch_id) then raise exception 'branch_access_denied'; end if;
  actor_role:=private.current_role(new.tenant_id);
  if actor_role is null then raise exception 'tenant_access_denied'; end if;
  if actor_role='auditor' then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('product','price_list','bundle','modifier') and actor_role not in ('owner','business_manager','branch_manager','supervisor') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('manual_journal','fiscal_period','tax','asset','accounting_settings') and actor_role not in ('owner','finance') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('purchase_order','goods_receipt','supplier_bill','purchase_return','payable','supplier') and actor_role not in ('owner','business_manager','branch_manager','supervisor','purchasing','warehouse','finance') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('stock_count','stock_transfer','stock_adjustment','lot') and actor_role not in ('owner','business_manager','branch_manager','supervisor','warehouse') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('sale','shift','cash_movement','refund') and actor_role not in ('owner','business_manager','branch_manager','supervisor','cashier','waiter') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('customer','customer_segment','loyalty','receivable') and actor_role not in ('owner','business_manager','branch_manager','supervisor','cashier','finance','service_staff','waiter') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('appointment','service') and actor_role not in ('owner','business_manager','branch_manager','supervisor','service_staff') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('dining_table','kitchen_order','recipe') and actor_role not in ('owner','business_manager','branch_manager','supervisor','kitchen','waiter') then raise exception 'permission_denied'; end if;
  return new;
end $$;

create or replace function public.create_qris_sale(
  sale_id uuid, target_branch_id uuid, client_device_id uuid, customer_id uuid,
  target_shift_id uuid, receipt_number text, lines jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=(select auth.uid()); membership public.memberships%rowtype; branch public.branches%rowtype;
  requested jsonb; product public.products%rowtype; quantity numeric(18,4); line_discount bigint;
  gross bigint; line_tax bigint; line_total bigint; subtotal bigint:=0; discount_total bigint:=0; tax_total bigint:=0;
  response_items jsonb:='[]'::jsonb;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  if jsonb_typeof(lines)<>'array' or jsonb_array_length(lines)=0 or jsonb_array_length(lines)>200 then raise exception 'invalid_lines'; end if;
  select * into branch from public.branches where id=target_branch_id and active;
  if branch.id is null then raise exception 'branch_not_found'; end if;
  select * into membership from public.memberships where tenant_id=branch.tenant_id and user_id=actor and active limit 1;
  if membership.id is null or membership.role not in ('owner','business_manager','branch_manager','supervisor','cashier','waiter') then raise exception 'permission_denied'; end if;
  if not private.can_access_branch(branch.tenant_id,branch.id) then raise exception 'branch_access_denied'; end if;
  if not exists(select 1 from public.devices where id=client_device_id and tenant_id=branch.tenant_id and branch_id=branch.id and status='active') then raise exception 'device_not_active'; end if;
  if not exists(select 1 from public.shifts where id=target_shift_id and tenant_id=branch.tenant_id and branch_id=branch.id and user_id=actor and status='open') then raise exception 'active_shift_required'; end if;
  if customer_id is not null and not exists(select 1 from public.customers where id=customer_id and tenant_id=branch.tenant_id) then raise exception 'customer_not_found'; end if;
  if not exists(select 1 from public.merchant_verifications where tenant_id=branch.tenant_id and status='approved' and qris_enabled) then raise exception 'qris_not_enabled'; end if;

  for requested in select value from jsonb_array_elements(lines) loop
    quantity:=(requested->>'quantity')::numeric;
    if quantity<=0 then raise exception 'invalid_quantity'; end if;
    select * into product from public.products where id=(requested->>'productId')::uuid and tenant_id=branch.tenant_id and business_id=branch.business_id and active for share;
    if product.id is null then raise exception 'product_not_found'; end if;
    gross:=round(product.price_minor*quantity);
    line_discount:=greatest(0,coalesce((requested->>'discountMinor')::bigint,0));
    if line_discount>gross or (membership.role in ('cashier','waiter') and line_discount>floor(gross*0.10)) then raise exception 'discount_limit_exceeded'; end if;
    line_tax:=round((gross-line_discount)*product.tax_rate/100);
    line_total:=gross-line_discount+line_tax;
    subtotal:=subtotal+gross; discount_total:=discount_total+line_discount; tax_total:=tax_total+line_tax;
    response_items:=response_items||jsonb_build_array(jsonb_build_object('id',product.id,'price',line_total,'quantity',1,'name',left(product.name||' x '||quantity::text,50)));
  end loop;

  insert into public.sales(id,tenant_id,business_id,branch_id,device_id,cashier_id,customer_id,shift_id,receipt_number,status,subtotal_minor,discount_minor,tax_minor,total_minor,paid_minor,payment_method,version,occurred_at)
  values(sale_id,branch.tenant_id,branch.business_id,branch.id,client_device_id,actor,customer_id,target_shift_id,receipt_number,'pending_payment',subtotal,discount_total,tax_total,subtotal-discount_total+tax_total,0,'qris',1,now());
  for requested in select value from jsonb_array_elements(lines) loop
    quantity:=(requested->>'quantity')::numeric;
    select * into product from public.products where id=(requested->>'productId')::uuid and tenant_id=branch.tenant_id;
    gross:=round(product.price_minor*quantity); line_discount:=greatest(0,coalesce((requested->>'discountMinor')::bigint,0));
    line_tax:=round((gross-line_discount)*product.tax_rate/100); line_total:=gross-line_discount+line_tax;
    insert into public.sale_items(tenant_id,sale_id,product_id,name,quantity,price_minor,cost_minor,discount_minor,tax_minor,total_minor)
    values(branch.tenant_id,sale_id,product.id,product.name,quantity,product.price_minor,product.cost_minor,line_discount,line_tax,line_total);
  end loop;
  insert into public.payments(tenant_id,sale_id,method,amount_minor,provider,provider_reference,provider_status)
  values(branch.tenant_id,sale_id,'qris',subtotal-discount_total+tax_total,'midtrans',sale_id::text,'pending');
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result)
  values(branch.tenant_id,actor,client_device_id,'payment.qris.create','sale',sale_id::text,'success');
  return jsonb_build_object('saleId',sale_id,'tenantId',branch.tenant_id,'orderId',sale_id::text,'receiptNumber',receipt_number,'amount',subtotal-discount_total+tax_total,'items',response_items,'currency','IDR');
end $$;

revoke all on function public.create_qris_sale(uuid,uuid,uuid,uuid,uuid,text,jsonb) from public;
grant execute on function public.create_qris_sale(uuid,uuid,uuid,uuid,uuid,text,jsonb) to authenticated;
revoke all on function private.can_read_sync_aggregate(uuid,text) from public;
grant execute on function private.can_read_sync_aggregate(uuid,text) to authenticated;

commit;
