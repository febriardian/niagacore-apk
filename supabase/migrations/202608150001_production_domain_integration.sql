begin;

-- Security fix: Supabase installs pgcrypto in the extensions schema. Functions
-- with an empty search_path must qualify both crypt and gen_salt explicitly.
create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_device_unlock_pin(target_device_id uuid, pin text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); member public.memberships%rowtype;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  if pin !~ '^[0-9]{6}$' then raise exception 'invalid_pin'; end if;
  select m.* into member from public.memberships m join public.devices d on d.tenant_id=m.tenant_id
    where m.user_id=actor and m.active and d.id=target_device_id and d.status='active' limit 1;
  if member.id is null then raise exception 'device_access_denied'; end if;
  insert into public.staff_device_pins(tenant_id,user_id,device_id,pin_hash)
  values(member.tenant_id,actor,target_device_id,extensions.crypt(pin,extensions.gen_salt('bf',10)))
  on conflict(tenant_id,user_id,device_id) do update set pin_hash=excluded.pin_hash,failed_attempts=0,locked_until=null,updated_at=now();
end $$;

create or replace function public.verify_device_unlock_pin(target_device_id uuid, pin text)
returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); pin_record public.staff_device_pins%rowtype; valid boolean;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  select * into pin_record from public.staff_device_pins where user_id=actor and device_id=target_device_id for update;
  if pin_record.user_id is null then return false; end if;
  if pin_record.locked_until>now() then raise exception 'pin_temporarily_locked'; end if;
  valid:=pin_record.pin_hash=extensions.crypt(pin,pin_record.pin_hash);
  if valid then
    update public.staff_device_pins set failed_attempts=0,locked_until=null,updated_at=now()
      where tenant_id=pin_record.tenant_id and user_id=actor and device_id=target_device_id;
  else
    update public.staff_device_pins set failed_attempts=failed_attempts+1,
      locked_until=case when failed_attempts+1>=5 then now()+interval '15 minutes' else locked_until end,updated_at=now()
      where tenant_id=pin_record.tenant_id and user_id=actor and device_id=target_device_id;
  end if;
  return valid;
end $$;

-- Earlier migrations attached two inventory-effect triggers to the same
-- business-record transition. Keep the dedicated idempotent inventory trigger
-- and make this trigger accounting-only so receipts/transfers are never doubled.
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
  if new.kind='receivable' and new.status='paid' then debit_code:=case when new.metadata->>'receiptAccount'='bank' then '1102' else '1101' end;credit_code:='1201';memo_text:='Penerimaan piutang'; end if;
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

-- Typed projections connect the operational menus. The generic record remains
-- the mutation source while these constrained tables become reporting/detail sources.
create or replace function private.project_operational_business_record()
returns trigger language plpgsql security definer set search_path='' as $$
declare item jsonb; linked_po public.business_records%rowtype; payable_id uuid;
begin
  if new.kind='supplier' then
    insert into public.partners(id,tenant_id,kind,name,phone,email,address)
      values(new.id,new.tenant_id,'supplier',new.title,nullif(new.metadata->>'phone',''),nullif(new.metadata->>'email',''),nullif(new.metadata->>'address',''))
      on conflict(id) do update set name=excluded.name,phone=excluded.phone,email=excluded.email,address=excluded.address,updated_at=now();
  elsif new.kind='purchase_order' then
    insert into public.purchase_orders(id,tenant_id,business_id,branch_id,supplier_id,document_number,status,ordered_at,expected_at,total_minor)
      values(new.id,new.tenant_id,new.business_id,new.branch_id,nullif(new.metadata->>'supplierId','')::uuid,coalesce(new.code,new.id::text),new.status,new.created_at,new.due_at,new.amount_minor)
      on conflict(id) do update set supplier_id=excluded.supplier_id,document_number=excluded.document_number,status=excluded.status,expected_at=excluded.expected_at,total_minor=excluded.total_minor;
    delete from public.purchase_order_lines where purchase_order_id=new.id;
    for item in select * from jsonb_array_elements(coalesce(new.metadata->'items','[]'::jsonb)) loop
      insert into public.purchase_order_lines(purchase_order_id,tenant_id,product_id,quantity,unit_cost_minor,tax_minor)
        values(new.id,new.tenant_id,(item->>'productId')::uuid,(item->>'quantity')::numeric,(item->>'unitCostMinor')::bigint,coalesce((item->>'taxMinor')::bigint,0));
    end loop;
  elsif new.kind='goods_receipt' then
    if nullif(new.metadata->>'purchaseOrderId','') is not null then
      select * into linked_po from public.business_records where id=(new.metadata->>'purchaseOrderId')::uuid and tenant_id=new.tenant_id and kind='purchase_order';
      if linked_po.id is null then raise exception 'purchase_order_not_found'; end if;
    end if;
    insert into public.goods_receipts(id,tenant_id,branch_id,purchase_order_id,document_number,status,received_at)
      values(new.id,new.tenant_id,new.branch_id,nullif(new.metadata->>'purchaseOrderId','')::uuid,coalesce(new.code,new.id::text),new.status,new.updated_at)
      on conflict(id) do update set purchase_order_id=excluded.purchase_order_id,document_number=excluded.document_number,status=excluded.status,received_at=excluded.received_at;
    delete from public.goods_receipt_lines where goods_receipt_id=new.id;
    insert into public.goods_receipt_lines(goods_receipt_id,tenant_id,product_id,quantity,lot_code,expires_at,unit_cost_minor)
      values(new.id,new.tenant_id,(new.metadata->>'productId')::uuid,new.quantity,nullif(new.metadata->>'lotNumber',''),nullif(new.metadata->>'expiresAt','')::date,
        coalesce(nullif(new.metadata->>'unitCostMinor','')::bigint,case when new.quantity>0 then round(new.amount_minor/new.quantity)::bigint else 0 end));
  elsif new.kind='stock_count' then
    insert into public.stock_counts(id,tenant_id,branch_id,warehouse_id,status,occurred_at,posted_at)
      values(new.id,new.tenant_id,new.branch_id,null,
        case new.status when 'review' then 'submitted' else new.status end,new.created_at,case when new.status='posted' then new.updated_at end)
      on conflict(id) do update set status=excluded.status,posted_at=excluded.posted_at;
    delete from public.stock_count_lines where stock_count_id=new.id;
    insert into public.stock_count_lines(stock_count_id,tenant_id,product_id,system_quantity,counted_quantity)
      values(new.id,new.tenant_id,(new.metadata->>'productId')::uuid,coalesce((new.metadata->>'systemQuantity')::numeric,0),new.quantity);
  elsif new.kind='stock_transfer' then
    insert into public.stock_transfers(id,tenant_id,source_branch_id,destination_branch_id,status,occurred_at)
      values(new.id,new.tenant_id,(new.metadata->>'sourceBranchId')::uuid,(new.metadata->>'destinationBranchId')::uuid,new.status,new.created_at)
      on conflict(id) do update set status=excluded.status;
    delete from public.stock_transfer_lines where stock_transfer_id=new.id;
    insert into public.stock_transfer_lines(stock_transfer_id,tenant_id,product_id,quantity)
      values(new.id,new.tenant_id,(new.metadata->>'productId')::uuid,abs(new.quantity));
  end if;
  if new.kind='supplier_bill' and new.status='posted' and not exists(
    select 1 from public.business_records r where r.tenant_id=new.tenant_id and r.kind='payable' and r.metadata->>'originId'=new.id::text
  ) then
    payable_id:=gen_random_uuid();
    insert into public.business_records(id,tenant_id,business_id,branch_id,kind,code,title,subtitle,status,amount_minor,quantity,due_at,metadata,active,version,created_by)
      values(payable_id,new.tenant_id,new.business_id,new.branch_id,'payable',new.code,'Utang · '||new.title,'Dibentuk otomatis dari tagihan pemasok','open',new.amount_minor,0,new.due_at,
        jsonb_build_object('supplierId',new.metadata->>'supplierId','paidMinor',0,'originType','supplier_bill','originId',new.id),true,1,new.created_by);
  end if;
  return new;
end $$;

drop trigger if exists project_operational_business_record on public.business_records;
create trigger project_operational_business_record after insert or update on public.business_records
for each row execute function private.project_operational_business_record();

create or replace function public.get_branch_dashboard(target_branch_id uuid, period_days integer default 30)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare tenant uuid; days integer:=least(greatest(period_days,1),90); today date:=(timezone('Asia/Jakarta',now()))::date; start_date date; previous_start date; result jsonb;
begin
  select b.tenant_id into tenant from public.branches b where b.id=target_branch_id and b.active;
  if tenant is null or not private.can_access_branch(tenant,target_branch_id) then raise exception 'branch_access_denied'; end if;
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
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare tenant uuid; today date:=(timezone('Asia/Jakarta',now()))::date; result jsonb;
begin
  select b.tenant_id into tenant from public.branches b where b.id=target_branch_id and b.active;
  if tenant is null or not private.can_access_branch(tenant,target_branch_id) then raise exception 'branch_access_denied'; end if;
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
