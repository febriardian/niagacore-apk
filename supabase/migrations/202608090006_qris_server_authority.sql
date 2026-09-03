begin;

create or replace function public.create_qris_sale(
  sale_id uuid, target_branch_id uuid, client_device_id uuid, customer_id uuid,
  receipt_number text, lines jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); membership public.memberships%rowtype; branch public.branches%rowtype;
  requested jsonb; product public.products%rowtype; quantity numeric(18,4);
  subtotal bigint := 0; tax_total bigint := 0; line_tax bigint; line_total bigint;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  if jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines)=0 or jsonb_array_length(lines)>200 then raise exception 'invalid_lines'; end if;
  select * into branch from public.branches where id=target_branch_id and active;
  if branch.id is null then raise exception 'branch_not_found'; end if;
  select * into membership from public.memberships where tenant_id=branch.tenant_id and user_id=actor and active limit 1;
  if membership.id is null then raise exception 'tenant_access_denied'; end if;
  if not exists(select 1 from public.membership_branches where membership_id=membership.id and branch_id=branch.id)
    and membership.role <> 'owner' then raise exception 'branch_access_denied'; end if;
  if not exists(select 1 from public.devices where id=client_device_id and tenant_id=branch.tenant_id and branch_id=branch.id and status='active')
    then raise exception 'device_not_active'; end if;
  if not exists(select 1 from public.merchant_verifications where tenant_id=branch.tenant_id and status='approved' and qris_enabled)
    then raise exception 'qris_not_enabled'; end if;

  for requested in select value from jsonb_array_elements(lines) loop
    quantity := (requested->>'quantity')::numeric;
    if quantity <= 0 then raise exception 'invalid_quantity'; end if;
    select * into product from public.products where id=(requested->>'productId')::uuid and tenant_id=branch.tenant_id
      and business_id=branch.business_id and active for share;
    if product.id is null then raise exception 'product_not_found'; end if;
    line_tax := round(product.price_minor * quantity * product.tax_rate / 100);
    line_total := round(product.price_minor * quantity) + line_tax;
    subtotal := subtotal + round(product.price_minor * quantity);
    tax_total := tax_total + line_tax;
  end loop;

  insert into public.sales(id,tenant_id,business_id,branch_id,device_id,cashier_id,customer_id,receipt_number,status,
    subtotal_minor,discount_minor,tax_minor,total_minor,paid_minor,payment_method,version,occurred_at)
  values(sale_id,branch.tenant_id,branch.business_id,branch.id,client_device_id,actor,customer_id,receipt_number,'pending_payment',
    subtotal,0,tax_total,subtotal+tax_total,0,'qris',1,now());
  for requested in select value from jsonb_array_elements(lines) loop
    quantity := (requested->>'quantity')::numeric;
    select * into product from public.products where id=(requested->>'productId')::uuid and tenant_id=branch.tenant_id;
    line_tax := round(product.price_minor * quantity * product.tax_rate / 100);
    line_total := round(product.price_minor * quantity) + line_tax;
    insert into public.sale_items(tenant_id,sale_id,product_id,name,quantity,price_minor,cost_minor,discount_minor,tax_minor,total_minor)
      values(branch.tenant_id,sale_id,product.id,product.name,quantity,product.price_minor,product.cost_minor,0,line_tax,line_total);
  end loop;
  insert into public.payments(tenant_id,sale_id,method,amount_minor,provider,provider_reference,provider_status)
    values(branch.tenant_id,sale_id,'qris',subtotal+tax_total,'midtrans',sale_id::text,'pending');
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result)
    values(branch.tenant_id,actor,client_device_id,'payment.qris.create','sale',sale_id::text,'success');
  return jsonb_build_object('saleId',sale_id,'orderId',sale_id::text,'amount',subtotal+tax_total,'currency','IDR');
end; $$;

create or replace function public.finalize_midtrans_payment(order_id text, provider_status text, gross_amount bigint, provider_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  payment public.payments%rowtype; sale public.sales%rowtype; item public.sale_items%rowtype;
  entry_id uuid; total_cost bigint := 0; net_revenue bigint;
begin
  select * into payment from public.payments where provider='midtrans' and provider_reference=order_id for update;
  if payment.id is null then raise exception 'payment_not_found'; end if;
  select * into sale from public.sales where id=payment.sale_id and tenant_id=payment.tenant_id for update;
  if sale.total_minor <> gross_amount or payment.amount_minor <> gross_amount then raise exception 'amount_mismatch'; end if;
  if sale.status='paid' then return jsonb_build_object('status','duplicate','saleId',sale.id); end if;
  if provider_status not in ('capture','settlement') then
    update public.payments set provider_status=provider_status,metadata=provider_payload where id=payment.id;
    if provider_status in ('cancel','deny','expire') then update public.sales set status='void',updated_at=now() where id=sale.id; end if;
    return jsonb_build_object('status','recorded','saleId',sale.id);
  end if;
  update public.payments set provider_status=provider_status,paid_at=now(),metadata=provider_payload where id=payment.id;
  update public.sales set status='paid',paid_minor=total_minor,updated_at=now(),version=version+1 where id=sale.id;
  for item in select * from public.sale_items where tenant_id=sale.tenant_id and sale_id=sale.id loop
    insert into public.inventory_movements(tenant_id,branch_id,product_id,movement_type,quantity,unit_cost_minor,reference_type,reference_id,occurred_at)
      values(sale.tenant_id,sale.branch_id,item.product_id,'sale',-item.quantity,item.cost_minor,'sale',sale.id,now());
    total_cost := total_cost + round(item.quantity * item.cost_minor);
  end loop;
  insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
    values(sale.tenant_id,sale.business_id,'sale',sale.id,'Penjualan QRIS','posted',now(),sale.cashier_id) returning id into entry_id;
  net_revenue := sale.total_minor-sale.tax_minor;
  insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
    (sale.tenant_id,entry_id,'1102',sale.total_minor,0,'Dana dalam penyelesaian'),
    (sale.tenant_id,entry_id,'4101',0,net_revenue,'Penjualan');
  if sale.tax_minor>0 then insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description)
    values(sale.tenant_id,entry_id,'2103',0,sale.tax_minor,'Pajak keluaran'); end if;
  if total_cost>0 then insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
    (sale.tenant_id,entry_id,'5101',total_cost,0,'HPP'),(sale.tenant_id,entry_id,'1301',0,total_cost,'Persediaan'); end if;
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result)
    values(sale.tenant_id,sale.cashier_id,sale.device_id,'payment.qris.paid','sale',sale.id::text,'success');
  return jsonb_build_object('status','paid','saleId',sale.id);
end; $$;

revoke all on function public.create_qris_sale(uuid,uuid,uuid,uuid,text,jsonb) from public;
grant execute on function public.create_qris_sale(uuid,uuid,uuid,uuid,text,jsonb) to authenticated;
revoke all on function public.finalize_midtrans_payment(text,text,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.finalize_midtrans_payment(text,text,bigint,jsonb) to service_role;

commit;
