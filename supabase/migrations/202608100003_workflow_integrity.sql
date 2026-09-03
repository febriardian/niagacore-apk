begin;

create table if not exists private.workflow_effects (
  tenant_id uuid not null,
  record_id uuid not null,
  target_status text not null,
  applied_at timestamptz not null default now(),
  primary key(tenant_id,record_id,target_status)
);

create or replace function private.workflow_transition_allowed(
  record_kind text, from_status text, to_status text
) returns boolean language sql immutable set search_path='' as $$
  select case
    when from_status=to_status then true
    when record_kind in ('customer','supplier','modifier','service','customer_segment')
      then (from_status,to_status) in (('active','inactive'),('inactive','active'),('active','blocked'),('blocked','active'))
    when record_kind='purchase_order' then (from_status,to_status) in (
      ('draft','submitted'),('submitted','approved'),('approved','partially_received'),
      ('approved','received'),('partially_received','received'),('draft','cancelled'),
      ('submitted','cancelled'),('approved','cancelled'))
    when record_kind in ('goods_receipt','supplier_bill','purchase_return','expense','stock_count','loyalty')
      then (from_status,to_status) in (('draft','checked'),('draft','verified'),('draft','approved'),
      ('draft','review'),('checked','posted'),('verified','posted'),('approved','posted'),
      ('review','posted'),('draft','cancelled'),('checked','cancelled'),('verified','cancelled'),
      ('approved','cancelled'),('review','cancelled'))
    when record_kind in ('payable','receivable') then (from_status,to_status) in (
      ('open','partially_paid'),('open','paid'),('partially_paid','paid'))
    when record_kind='manual_journal' then (from_status,to_status) in (
      ('draft','pending_approval'),('pending_approval','posted'),('posted','reversed'))
    when record_kind='fiscal_period' then (from_status,to_status) in (
      ('open','soft_closed'),('soft_closed','hard_closed'),('soft_closed','open'),('hard_closed','open'))
    when record_kind='asset' then (from_status,to_status) in (('draft','active'),('active','disposed'))
    when record_kind='tax' then (from_status,to_status) in (('draft','active'),('active','expired'))
    when record_kind='stock_transfer' then (from_status,to_status) in (
      ('draft','approved'),('approved','in_transit'),('in_transit','received'),
      ('draft','cancelled'),('approved','cancelled'))
    when record_kind='lot' then (from_status,to_status) in (
      ('available','quarantined'),('quarantined','available'),('available','expired'),('quarantined','expired'))
    when record_kind='price_list' then (from_status,to_status) in (('draft','active'),('active','expired'))
    when record_kind in ('bundle','recipe') then (from_status,to_status) in (
      ('draft','active'),('active','inactive'),('active','superseded'))
    when record_kind='dining_table' then (from_status,to_status) in (
      ('available','occupied'),('available','reserved'),('reserved','occupied'),
      ('occupied','billing'),('billing','cleaning'),('cleaning','available'))
    when record_kind='kitchen_order' then (from_status,to_status) in (
      ('queued','preparing'),('preparing','ready'),('ready','served'),('queued','cancelled'))
    when record_kind='appointment' then (from_status,to_status) in (
      ('booked','confirmed'),('confirmed','in_progress'),('in_progress','completed'),
      ('booked','cancelled'),('confirmed','cancelled'),('booked','no_show'),('confirmed','no_show'))
    when record_kind='staff' then (from_status,to_status) in (
      ('invited','active'),('active','suspended'),('suspended','active'))
    when record_kind='device' then (from_status,to_status)=('active','revoked')
    when record_kind='hardware' then (from_status,to_status) in (
      ('experimental','supported'),('supported','deprecated'))
    when record_kind='notification' then (from_status,to_status) in (
      ('unread','read'),('read','resolved'))
    else false
  end;
$$;

create or replace function private.guard_business_record_transition()
returns trigger language plpgsql security definer set search_path='' as $$
declare actor_role text;
begin
  if old.status=new.status then return new; end if;
  if not private.workflow_transition_allowed(new.kind,old.status,new.status) then
    raise exception 'invalid_workflow_transition:%:%:%',new.kind,old.status,new.status;
  end if;
  select role into actor_role from public.memberships
    where tenant_id=new.tenant_id and user_id=auth.uid() and active limit 1;
  if actor_role is null then raise exception 'tenant_access_denied'; end if;
  if new.kind=any(array['manual_journal','fiscal_period','tax','asset','staff','device','hardware'])
    and actor_role<>'owner' then raise exception 'owner_approval_required'; end if;
  if new.status=any(array['approved','posted','paid','hard_closed','reversed','revoked','supported'])
    and actor_role='cashier' then raise exception 'supervisor_approval_required'; end if;
  new.metadata:=jsonb_set(
    coalesce(new.metadata,'{}'::jsonb),'{serverTransition}',
    jsonb_build_object('from',old.status,'to',new.status,'actorId',auth.uid(),'occurredAt',now()),true
  );
  return new;
end;
$$;

create or replace function private.post_workflow_journal(
  record public.business_records, debit_code text, credit_code text, memo_text text
) returns void language plpgsql security definer set search_path='' as $$
declare entry_id uuid;
begin
  if record.amount_minor<=0 or debit_code is null or credit_code is null or debit_code=credit_code then return; end if;
  if exists(select 1 from public.journal_entries where tenant_id=record.tenant_id
    and source_type='workflow:'||record.kind||':'||record.status and source_id=record.id) then return; end if;
  insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
  values(record.tenant_id,record.business_id,'workflow:'||record.kind||':'||record.status,
    record.id,memo_text,'posted',now(),auth.uid()) returning id into entry_id;
  insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
    (record.tenant_id,entry_id,debit_code,record.amount_minor,0,memo_text),
    (record.tenant_id,entry_id,credit_code,0,record.amount_minor,memo_text);
end;
$$;

create or replace function private.apply_business_record_effect()
returns trigger language plpgsql security definer set search_path='' as $$
declare product uuid; movement numeric; movement_kind public.stock_movement_type;
  destination uuid; debit_code text; credit_code text; memo_text text;
  previous_entry public.journal_entries%rowtype; reverse_entry uuid; line record;
begin
  if old.status=new.status then return new; end if;
  insert into private.workflow_effects(tenant_id,record_id,target_status)
    values(new.tenant_id,new.id,new.status) on conflict do nothing;
  if not found then return new; end if;

  begin product:=(new.metadata->>'productId')::uuid; exception when others then product:=null; end;
  movement:=0; movement_kind:=null; destination:=new.branch_id;
  if new.kind='goods_receipt' and new.status='posted' then movement:=new.quantity;movement_kind:='purchase'; end if;
  if new.kind='purchase_return' and new.status='posted' then movement:=-abs(new.quantity);movement_kind:='return_out'; end if;
  if new.kind='stock_count' and new.status='posted' then movement:=new.quantity-coalesce((new.metadata->>'systemQuantity')::numeric,0);movement_kind:='adjustment'; end if;
  if new.kind='stock_transfer' and new.status='in_transit' then movement:=-abs(new.quantity);movement_kind:='transfer_out'; end if;
  if new.kind='stock_transfer' and new.status='received' then
    movement:=abs(new.quantity);movement_kind:='transfer_in';
    begin destination:=(new.metadata->>'destinationBranchId')::uuid; exception when others then destination:=new.branch_id; end;
  end if;
  if product is not null and movement<>0 then
    insert into public.inventory_movements(tenant_id,branch_id,product_id,movement_type,quantity,
      reference_type,reference_id,occurred_at)
    values(new.tenant_id,destination,product,movement_kind,movement,new.kind,new.id,now());
  end if;

  if new.kind='expense' and new.status='posted' then debit_code:='6101';credit_code:=case when new.metadata->>'paidFrom'='bank' then '1102' else '1101' end;memo_text:='Beban operasional'; end if;
  if new.kind='supplier_bill' and new.status='posted' then debit_code:='1301';credit_code:='2101';memo_text:='Tagihan pemasok'; end if;
  if new.kind='purchase_return' and new.status='posted' then debit_code:='2101';credit_code:='1301';memo_text:='Retur pembelian'; end if;
  if new.kind='payable' and new.status='paid' then debit_code:='2101';credit_code:=case when new.metadata->>'paymentAccount'='bank' then '1102' else '1101' end;memo_text:='Pembayaran utang'; end if;
  if new.kind='receivable' and new.status='paid' then debit_code:=case when new.metadata->>'receiptAccount'='bank' then '1102' else '1101' end;credit_code:='1201';memo_text:='Penerimaan piutang'; end if;
  if new.kind='asset' and new.status='active' then debit_code:=coalesce(nullif(new.metadata->>'assetAccount',''),'1501');credit_code:='1101';memo_text:='Kapitalisasi aset'; end if;
  if new.kind='manual_journal' and new.status='posted' then debit_code:=new.metadata->>'debitAccount';credit_code:=new.metadata->>'creditAccount';memo_text:=coalesce(new.metadata->>'explanation',new.title); end if;
  if debit_code is not null then perform private.post_workflow_journal(new,debit_code,credit_code,memo_text); end if;

  if new.kind='manual_journal' and new.status='reversed' then
    select * into previous_entry from public.journal_entries where tenant_id=new.tenant_id
      and source_type='workflow:manual_journal:posted' and source_id=new.id;
    if previous_entry.id is null then raise exception 'posted_journal_not_found'; end if;
    insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
    values(new.tenant_id,new.business_id,'workflow:manual_journal:reversed',new.id,
      'Reversal: '||new.title,'posted',now(),auth.uid()) returning id into reverse_entry;
    for line in select * from public.journal_lines where tenant_id=new.tenant_id and entry_id=previous_entry.id loop
      insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description)
      values(new.tenant_id,reverse_entry,line.account_code,line.credit_minor,line.debit_minor,'Reversal');
    end loop;
    update public.journal_entries set status='reversed' where id=previous_entry.id;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_business_record_transition on public.business_records;
create trigger guard_business_record_transition before update of status on public.business_records
for each row execute function private.guard_business_record_transition();

drop trigger if exists apply_business_record_effect on public.business_records;
create trigger apply_business_record_effect after update of status on public.business_records
for each row execute function private.apply_business_record_effect();

commit;
