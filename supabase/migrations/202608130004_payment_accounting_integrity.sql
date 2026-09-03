begin;

create or replace function public.finalize_midtrans_payment(order_id text, provider_status text, gross_amount bigint, provider_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  payment public.payments%rowtype; sale public.sales%rowtype; item public.sale_items%rowtype;
  entry_id uuid; total_cost bigint:=0; net_revenue bigint; sync_payload jsonb;
begin
  select * into payment from public.payments where provider='midtrans' and provider_reference=order_id for update;
  if payment.id is null then raise exception 'payment_not_found'; end if;
  select * into sale from public.sales where id=payment.sale_id and tenant_id=payment.tenant_id for update;
  if sale.total_minor<>gross_amount or payment.amount_minor<>gross_amount then raise exception 'amount_mismatch'; end if;
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
    total_cost:=total_cost+round(item.quantity*item.cost_minor);
  end loop;
  insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
  values(sale.tenant_id,sale.business_id,'sale',sale.id,'Penjualan QRIS','posted',now(),sale.cashier_id) returning id into entry_id;
  net_revenue:=sale.total_minor-sale.tax_minor;
  insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
    (sale.tenant_id,entry_id,'1102',sale.total_minor,0,'Dana dalam penyelesaian'),
    (sale.tenant_id,entry_id,'4101',0,net_revenue,'Penjualan');
  if sale.tax_minor>0 then insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description)
    values(sale.tenant_id,entry_id,'2103',0,sale.tax_minor,'Pajak keluaran'); end if;
  if total_cost>0 then insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
    (sale.tenant_id,entry_id,'5101',total_cost,0,'HPP'),(sale.tenant_id,entry_id,'1301',0,total_cost,'Persediaan'); end if;

  select jsonb_build_object(
    'receiptNumber',sale.receipt_number,'subtotalMinor',sale.subtotal_minor,
    'discountMinor',sale.discount_minor,'taxMinor',sale.tax_minor,'totalMinor',sale.total_minor,
    'paymentMethod','qris','customerId',sale.customer_id,'shiftId',sale.shift_id,
    'lines',coalesce(jsonb_agg(jsonb_build_object(
      'productId',si.product_id,'name',si.name,'quantity',si.quantity,
      'priceMinor',si.price_minor,'costMinor',si.cost_minor,'discountMinor',si.discount_minor,
      'taxMinor',si.tax_minor,'totalMinor',si.total_minor
    ) order by si.id),'[]'::jsonb)
  ) into sync_payload from public.sale_items si where si.tenant_id=sale.tenant_id and si.sale_id=sale.id;

  insert into public.sync_mutations(mutation_id,tenant_id,business_id,branch_id,device_id,actor_id,idempotency_key,aggregate_type,aggregate_id,operation,base_version,schema_version,payload,occurred_at)
  values(gen_random_uuid(),sale.tenant_id,sale.business_id,sale.branch_id,sale.device_id,sale.cashier_id,'midtrans-paid:'||sale.id,'sale',sale.id,'create',null,1,sync_payload,now())
  on conflict(tenant_id,idempotency_key) do nothing;
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result)
  values(sale.tenant_id,sale.cashier_id,sale.device_id,'payment.qris.paid','sale',sale.id::text,'success');
  return jsonb_build_object('status','paid','saleId',sale.id,'receiptNumber',sale.receipt_number,'amount',sale.total_minor);
end $$;

create or replace function private.reject_posted_journal_mutation()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='journal_entries' and old.status='posted' then raise exception 'posted_journal_is_immutable'; end if;
  if tg_table_name='journal_lines' and exists(select 1 from public.journal_entries e where e.tenant_id=old.tenant_id and e.id=old.entry_id and e.status='posted') then raise exception 'posted_journal_is_immutable'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create or replace function private.update_moving_average_cost()
returns trigger language plpgsql security definer set search_path='' as $$
declare previous_quantity numeric(18,4); previous_cost bigint; next_cost bigint;
begin
  if new.movement_type<>'purchase' or new.quantity<=0 or new.unit_cost_minor is null then return new; end if;
  select p.cost_minor into previous_cost from public.products p where p.tenant_id=new.tenant_id and p.id=new.product_id for update;
  select coalesce(sum(m.quantity),0)-new.quantity into previous_quantity from public.inventory_movements m
    where m.tenant_id=new.tenant_id and m.branch_id=new.branch_id and m.product_id=new.product_id;
  previous_quantity:=greatest(0,previous_quantity);
  next_cost:=round(((previous_quantity*coalesce(previous_cost,0))+(new.quantity*new.unit_cost_minor))/greatest(1,previous_quantity+new.quantity));
  update public.products set cost_minor=next_cost,version=version+1,updated_at=now() where tenant_id=new.tenant_id and id=new.product_id;
  return new;
end $$;
drop trigger if exists inventory_moving_average_cost on public.inventory_movements;
create trigger inventory_moving_average_cost after insert on public.inventory_movements for each row execute function private.update_moving_average_cost();
drop trigger if exists journal_entries_immutable on public.journal_entries;
create trigger journal_entries_immutable before update or delete on public.journal_entries for each row execute function private.reject_posted_journal_mutation();
drop trigger if exists journal_lines_immutable on public.journal_lines;
create trigger journal_lines_immutable before update or delete on public.journal_lines for each row execute function private.reject_posted_journal_mutation();

create or replace function private.validate_journal_balance()
returns trigger language plpgsql set search_path='' as $$
declare target_entry uuid:=coalesce(new.entry_id,old.entry_id); debit_sum bigint; credit_sum bigint;
begin
  select coalesce(sum(debit_minor),0),coalesce(sum(credit_minor),0) into debit_sum,credit_sum from public.journal_lines where entry_id=target_entry;
  if debit_sum<>credit_sum then raise exception 'journal_not_balanced'; end if;
  return null;
end $$;
drop trigger if exists journal_lines_balance on public.journal_lines;
create constraint trigger journal_lines_balance after insert or update or delete on public.journal_lines deferrable initially deferred for each row execute function private.validate_journal_balance();

revoke all on function public.finalize_midtrans_payment(text,text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_midtrans_payment(text,text,bigint,jsonb) to service_role;

commit;
