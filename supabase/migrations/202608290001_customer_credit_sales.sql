begin;

-- A credit sale recognizes revenue and stock once, then keeps every customer
-- payment as an auditable installment against the same sale/receivable.
create or replace function private.guard_business_record_transition()
returns trigger language plpgsql security definer set search_path='' as $$
declare actor_role text; secure_receivable_payment boolean:=false;
begin
  if old.status=new.status then return new; end if;
  if not private.workflow_transition_allowed(new.kind,old.status,new.status) then
    raise exception 'invalid_workflow_transition:%:%:%',new.kind,old.status,new.status;
  end if;
  select role into actor_role from public.memberships
    where tenant_id=new.tenant_id and user_id=auth.uid() and active limit 1;
  if actor_role is null then raise exception 'tenant_access_denied'; end if;
  if new.kind='receivable' and new.metadata->>'paymentJournalMode'='installments' and nullif(new.metadata->>'lastPaymentId','') is not null then
    secure_receivable_payment:=exists(select 1 from public.payments p where p.id=(new.metadata->>'lastPaymentId')::uuid
      and p.tenant_id=new.tenant_id and p.metadata->>'receivableId'=new.id::text and p.provider_status='settled');
  end if;
  if new.kind=any(array['manual_journal','fiscal_period','tax','asset'])
    and actor_role not in ('owner','finance') then raise exception 'accounting_permission_denied'; end if;
  if new.kind=any(array['staff','device','hardware'])
    and actor_role<>'owner' then raise exception 'owner_approval_required'; end if;
  if new.status=any(array['approved','posted','paid','hard_closed','reversed','revoked','supported'])
    and actor_role='cashier' and not secure_receivable_payment then raise exception 'supervisor_approval_required'; end if;
  new.metadata:=jsonb_set(coalesce(new.metadata,'{}'::jsonb),'{serverTransition}',
    jsonb_build_object('from',old.status,'to',new.status,'actorId',auth.uid(),'occurredAt',now()),true);
  return new;
end $$;

create or replace function private.apply_business_record_effect()
returns trigger language plpgsql security definer set search_path='' as $$
declare debit_code text; credit_code text; memo_text text; previous_entry public.journal_entries%rowtype; reverse_entry uuid; line record;
begin
  if old.status=new.status then return new; end if;
  insert into private.workflow_effects(tenant_id,record_id,target_status)
    values(new.tenant_id,new.id,new.status) on conflict do nothing;
  if not found then return new; end if;
  if new.kind='expense' and new.status='posted' then debit_code:='6101';credit_code:=case when new.metadata->>'paidFrom'='bank' then '1102' else '1101' end;memo_text:='Beban operasional'; end if;
  if new.kind='supplier_bill' and new.status='posted' then debit_code:='1301';credit_code:='2101';memo_text:='Tagihan pemasok'; end if;
  if new.kind='purchase_return' and new.status='posted' then debit_code:='2101';credit_code:='1301';memo_text:='Retur pembelian'; end if;
  if new.kind='payable' and new.status='paid' then debit_code:='2101';credit_code:=case when new.metadata->>'paymentAccount'='bank' then '1102' else '1101' end;memo_text:='Pembayaran utang'; end if;
  if new.kind='receivable' and new.status='paid' and coalesce(new.metadata->>'paymentJournalMode','')<>'installments' then
    debit_code:=case when new.metadata->>'receiptAccount'='bank' then '1102' else '1101' end;credit_code:='1201';memo_text:='Penerimaan piutang';
  end if;
  if new.kind='asset' and new.status='active' then debit_code:=coalesce(nullif(new.metadata->>'assetAccount',''),'1501');credit_code:='1101';memo_text:='Kapitalisasi aset'; end if;
  if debit_code is not null then perform private.post_workflow_journal(new,debit_code,credit_code,memo_text); end if;
  if new.kind='manual_journal' and new.status='reversed' then
    select * into previous_entry from public.journal_entries where tenant_id=new.tenant_id and source_type='workflow:manual_journal:posted' and source_id=new.id;
    if previous_entry.id is null then raise exception 'posted_journal_not_found'; end if;
    insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
      values(new.tenant_id,new.business_id,'workflow:manual_journal:reversed',new.id,'Reversal: '||new.title,'posted',now(),auth.uid())
      on conflict(tenant_id,source_type,source_id) do nothing returning id into reverse_entry;
    if reverse_entry is not null then
      for line in select * from public.journal_lines where tenant_id=new.tenant_id and entry_id=previous_entry.id loop
        insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description)
          values(new.tenant_id,reverse_entry,line.account_code,line.credit_minor,line.debit_minor,'Reversal');
      end loop;
    end if;
  end if;
  return new;
end $$;

create or replace function public.create_credit_sale(
  target_sale_id uuid,
  target_branch_id uuid,
  client_device_id uuid,
  target_shift_id uuid,
  target_customer_id uuid,
  target_receipt_number text,
  requested_lines jsonb,
  paid_now_minor bigint default 0,
  target_due_at date default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=(select auth.uid()); member public.memberships%rowtype; branch public.branches%rowtype;
  customer public.customers%rowtype; product public.products%rowtype; requested jsonb; existing public.sales%rowtype;
  quantity numeric(18,4); gross bigint; line_discount bigint; line_tax bigint; line_total bigint;
  subtotal bigint:=0; discount_total bigint:=0; tax_total bigint:=0; total_cost bigint:=0; total bigint;
  receivable_id uuid:=gen_random_uuid(); payment_id uuid:=gen_random_uuid(); entry_id uuid; outstanding bigint; current_stock numeric;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  select * into existing from public.sales where id=target_sale_id;
  if existing.id is not null then
    select id into receivable_id from public.business_records where tenant_id=existing.tenant_id and kind='receivable' and metadata->>'saleId'=existing.id::text limit 1;
    return jsonb_build_object('saleId',existing.id,'receivableId',receivable_id,'receiptNumber',existing.receipt_number,
      'totalMinor',existing.total_minor,'paidNowMinor',existing.paid_minor,'outstandingMinor',existing.total_minor-existing.paid_minor);
  end if;
  select * into branch from public.branches where id=target_branch_id and active;
  if branch.id is null then raise exception 'branch_not_found'; end if;
  select * into member from public.memberships where tenant_id=branch.tenant_id and user_id=actor and active limit 1;
  if member.id is null or member.role not in ('owner','business_manager','branch_manager','supervisor','cashier','waiter') then raise exception 'permission_denied'; end if;
  if not private.can_access_branch(branch.tenant_id,branch.id) then raise exception 'branch_access_denied'; end if;
  if not exists(select 1 from public.devices where id=client_device_id and tenant_id=branch.tenant_id and branch_id=branch.id and status='active') then raise exception 'device_not_active'; end if;
  if not exists(select 1 from public.shifts where id=target_shift_id and tenant_id=branch.tenant_id and branch_id=branch.id and user_id=actor and status='open') then raise exception 'active_shift_required'; end if;
  select * into customer from public.customers where id=target_customer_id and tenant_id=branch.tenant_id for update;
  if customer.id is null then raise exception 'customer_required_for_credit'; end if;
  if jsonb_typeof(requested_lines)<>'array' or jsonb_array_length(requested_lines)=0 or jsonb_array_length(requested_lines)>200 then raise exception 'invalid_lines'; end if;

  for requested in select value from jsonb_array_elements(requested_lines) loop
    quantity:=(requested->>'quantity')::numeric;
    if quantity<=0 then raise exception 'invalid_quantity'; end if;
    select * into product from public.products where id=(requested->>'productId')::uuid and tenant_id=branch.tenant_id and business_id=branch.business_id and active for share;
    if product.id is null then raise exception 'product_not_found'; end if;
    gross:=round(product.price_minor*quantity);
    line_discount:=greatest(0,coalesce((requested->>'discountMinor')::bigint,0));
    if line_discount>gross or (member.role in ('cashier','waiter') and line_discount>floor(gross*0.10)) then raise exception 'discount_limit_exceeded'; end if;
    if product.track_stock and not product.allow_negative then
      select coalesce(sum(movement.quantity),0) into current_stock
      from public.inventory_movements movement
      where movement.tenant_id=branch.tenant_id and movement.branch_id=branch.id and movement.product_id=product.id;
      if current_stock<quantity then raise exception 'insufficient_stock:%',product.name; end if;
    end if;
    line_tax:=round((gross-line_discount)*product.tax_rate/100);
    subtotal:=subtotal+gross; discount_total:=discount_total+line_discount; tax_total:=tax_total+line_tax;
  end loop;
  total:=subtotal-discount_total+tax_total;
  if total<=0 then raise exception 'invalid_sale_total'; end if;
  if paid_now_minor<0 or paid_now_minor>=total then raise exception 'invalid_credit_payment'; end if;
  outstanding:=total-paid_now_minor;

  insert into public.sales(id,tenant_id,business_id,branch_id,device_id,cashier_id,customer_id,shift_id,receipt_number,status,
    subtotal_minor,discount_minor,tax_minor,total_minor,paid_minor,payment_method,version,occurred_at)
  values(target_sale_id,branch.tenant_id,branch.business_id,branch.id,client_device_id,actor,customer.id,target_shift_id,
    target_receipt_number,'paid',subtotal,discount_total,tax_total,total,paid_now_minor,'credit',1,now());

  for requested in select value from jsonb_array_elements(requested_lines) loop
    quantity:=(requested->>'quantity')::numeric;
    select * into product from public.products where id=(requested->>'productId')::uuid and tenant_id=branch.tenant_id;
    gross:=round(product.price_minor*quantity); line_discount:=greatest(0,coalesce((requested->>'discountMinor')::bigint,0));
    line_tax:=round((gross-line_discount)*product.tax_rate/100); line_total:=gross-line_discount+line_tax;
    insert into public.sale_items(tenant_id,sale_id,product_id,name,quantity,price_minor,cost_minor,discount_minor,tax_minor,total_minor)
      values(branch.tenant_id,target_sale_id,product.id,product.name,quantity,product.price_minor,product.cost_minor,line_discount,line_tax,line_total);
    if product.track_stock then
      insert into public.inventory_movements(tenant_id,branch_id,product_id,movement_type,quantity,unit_cost_minor,reference_type,reference_id,occurred_at)
        values(branch.tenant_id,branch.id,product.id,'sale',-quantity,product.cost_minor,'sale',target_sale_id,now());
    end if;
    total_cost:=total_cost+round(quantity*product.cost_minor);
  end loop;
  if paid_now_minor>0 then
    insert into public.payments(id,tenant_id,sale_id,method,amount_minor,provider_status,metadata,paid_at)
      values(payment_id,branch.tenant_id,target_sale_id,'cash',paid_now_minor,'settled',jsonb_build_object('kind','initial_credit_payment','shiftId',target_shift_id),now());
  end if;
  insert into public.business_records(id,tenant_id,business_id,branch_id,kind,code,title,subtitle,status,amount_minor,due_at,metadata,active,version,created_by)
    values(receivable_id,branch.tenant_id,branch.business_id,branch.id,'receivable',target_receipt_number,customer.name,
      'Piutang dari penjualan '||target_receipt_number,case when paid_now_minor>0 then 'partially_paid' else 'open' end,total,
      coalesce(target_due_at,(timezone('Asia/Jakarta',now()))::date+30),
      jsonb_build_object('customerId',customer.id,'saleId',target_sale_id,'receiptNumber',target_receipt_number,'receivedMinor',paid_now_minor,
        'paymentJournalMode','installments','receiptAccount','cash'),true,1,actor);
  update public.customers set balance_minor=balance_minor+outstanding,updated_at=now(),version=version+1 where id=customer.id;

  insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
    values(branch.tenant_id,branch.business_id,'sale',target_sale_id,'Penjualan kredit '||target_receipt_number,'posted',now(),actor) returning id into entry_id;
  insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
    (branch.tenant_id,entry_id,'1201',outstanding,0,'Piutang pelanggan'),
    (branch.tenant_id,entry_id,'4101',0,total-tax_total,'Penjualan');
  if paid_now_minor>0 then insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values(branch.tenant_id,entry_id,'1101',paid_now_minor,0,'Pembayaran awal tunai'); end if;
  if tax_total>0 then insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values(branch.tenant_id,entry_id,'2103',0,tax_total,'Pajak keluaran'); end if;
  if total_cost>0 then insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
    (branch.tenant_id,entry_id,'5101',total_cost,0,'HPP'),(branch.tenant_id,entry_id,'1301',0,total_cost,'Persediaan'); end if;
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result,reason)
    values(branch.tenant_id,actor,client_device_id,'payment.credit.create','sale',target_sale_id::text,'success','Piutang '||outstanding::text);
  return jsonb_build_object('saleId',target_sale_id,'receivableId',receivable_id,'receiptNumber',target_receipt_number,
    'totalMinor',total,'paidNowMinor',paid_now_minor,'outstandingMinor',outstanding);
end $$;

create or replace function public.settle_customer_receivable(
  target_receivable_id uuid,
  target_payment_id uuid,
  target_shift_id uuid,
  amount_minor bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=(select auth.uid()); document public.subledger_documents%rowtype; record public.business_records%rowtype;
  sale public.sales%rowtype; payment public.payments%rowtype; new_settled bigint; remaining bigint; next_status text; entry_id uuid;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  select * into payment from public.payments where id=target_payment_id;
  if payment.id is not null then
    select * into document from public.subledger_documents where id=target_receivable_id;
    return jsonb_build_object('paidMinor',payment.amount_minor,'outstandingMinor',greatest(document.original_minor-document.settled_minor,0),'status',document.status);
  end if;
  select * into document from public.subledger_documents where id=target_receivable_id and document_type='receivable' for update;
  if document.id is null then raise exception 'receivable_not_found'; end if;
  if not private.can_access_branch(document.tenant_id,document.branch_id) then raise exception 'branch_access_denied'; end if;
  if not exists(select 1 from public.memberships where tenant_id=document.tenant_id and user_id=actor and active and role in ('owner','business_manager','branch_manager','supervisor','cashier','finance')) then raise exception 'permission_denied'; end if;
  if not exists(select 1 from public.shifts where id=target_shift_id and tenant_id=document.tenant_id and branch_id=document.branch_id and user_id=actor and status='open') then raise exception 'active_shift_required'; end if;
  if amount_minor<=0 or amount_minor>document.original_minor-document.settled_minor then raise exception 'invalid_receivable_payment'; end if;
  select * into record from public.business_records where id=document.id and tenant_id=document.tenant_id;
  select * into sale from public.sales where id=(record.metadata->>'saleId')::uuid and tenant_id=document.tenant_id for update;
  if sale.id is null then raise exception 'origin_sale_not_found'; end if;
  new_settled:=document.settled_minor+amount_minor; remaining:=document.original_minor-new_settled;
  next_status:=case when remaining=0 then 'paid' else 'partially_paid' end;
  insert into public.payments(id,tenant_id,sale_id,method,amount_minor,provider_status,metadata,paid_at)
    values(target_payment_id,document.tenant_id,sale.id,'cash',amount_minor,'settled',jsonb_build_object('kind','receivable_installment','receivableId',document.id,'shiftId',target_shift_id),now());
  update public.sales set paid_minor=least(total_minor,paid_minor+amount_minor),updated_at=now(),version=version+1 where id=sale.id;
  update public.business_records set status=next_status,
    metadata=jsonb_set(jsonb_set(metadata,'{receivedMinor}',to_jsonb(new_settled),true),'{lastPaymentId}',to_jsonb(target_payment_id::text),true),
    updated_at=now(),version=version+1 where id=record.id;
  update public.customers set balance_minor=greatest(balance_minor-amount_minor,0),updated_at=now(),version=version+1 where id=(record.metadata->>'customerId')::uuid;
  insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
    values(document.tenant_id,document.business_id,'receivable_payment',target_payment_id,'Pembayaran piutang '||coalesce(record.code,record.id::text),'posted',now(),actor) returning id into entry_id;
  insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
    (document.tenant_id,entry_id,'1101',amount_minor,0,'Kas'),(document.tenant_id,entry_id,'1201',0,amount_minor,'Piutang pelanggan');
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result,reason)
    select document.tenant_id,actor,sh.device_id,'payment.credit.settle','receivable',document.id::text,'success','Pembayaran '||amount_minor::text from public.shifts sh where sh.id=target_shift_id;
  return jsonb_build_object('paidMinor',amount_minor,'outstandingMinor',remaining,'status',next_status);
end $$;

-- Cash flow uses actual payment rows, so credit sales are not counted as cash
-- until the payment is really received and are never counted twice.
create or replace function public.get_branch_management_report(target_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare tenant uuid; today date:=(timezone('Asia/Jakarta',now()))::date; result jsonb;
begin
  select b.tenant_id into tenant from public.branches b where b.id=target_branch_id and b.active;
  if tenant is null or not exists(
    select 1 from public.memberships m
    where m.tenant_id=tenant and m.user_id=(select auth.uid()) and m.active
      and (m.role in ('owner','business_manager') or exists(
        select 1 from public.membership_branches mb where mb.tenant_id=m.tenant_id and mb.membership_id=m.id and mb.branch_id=target_branch_id
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
  ) select jsonb_build_object(
    'cashInMinor',coalesce((select sum(p.amount_minor) from public.payments p join public.sales s on s.tenant_id=p.tenant_id and s.id=p.sale_id where p.tenant_id=tenant and s.branch_id=target_branch_id and p.paid_at is not null),0)::bigint,
    'cashOutMinor',(coalesce((select sum(amount_minor) from public.business_records where tenant_id=tenant and branch_id=target_branch_id and kind='expense' and status='posted'),0)+coalesce((select sum(settled_minor) from public.subledger_documents where tenant_id=tenant and branch_id=target_branch_id and document_type='payable'),0))::bigint,
    'inventoryValueMinor',coalesce((select round(sum(greatest(quantity,0)*cost_minor)) from stock),0)::bigint,
    'outputTaxMinor',coalesce((select sum(tax_minor) from public.sales where tenant_id=tenant and branch_id=target_branch_id and status='paid'),0)::bigint,
    'inputTaxMinor',coalesce((select sum(coalesce(round(nullif(metadata->>'taxMinor','')::numeric),0)::bigint) from public.business_records where tenant_id=tenant and branch_id=target_branch_id and kind in('supplier_bill','expense') and status='posted'),0)::bigint,
    'aging',coalesce((select jsonb_agg(jsonb_build_object('kind',case document_type when 'receivable' then 'Piutang' else 'Utang' end,'currentMinor',current_minor,'days30Minor',days30_minor,'days60Minor',days60_minor,'over90Minor',over90_minor)) from aging),'[]'::jsonb)
  ) into result;
  return result;
end $$;

revoke all on function public.create_credit_sale(uuid,uuid,uuid,uuid,uuid,text,jsonb,bigint,date) from public,anon;
grant execute on function public.create_credit_sale(uuid,uuid,uuid,uuid,uuid,text,jsonb,bigint,date) to authenticated;
revoke all on function public.settle_customer_receivable(uuid,uuid,uuid,bigint) from public,anon;
grant execute on function public.settle_customer_receivable(uuid,uuid,uuid,bigint) to authenticated;
revoke all on function public.get_branch_management_report(uuid) from public,anon;
grant execute on function public.get_branch_management_report(uuid) to authenticated;

commit;
