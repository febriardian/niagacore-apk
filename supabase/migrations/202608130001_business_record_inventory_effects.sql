begin;

-- Workflow inventory effects used to exist only in the device SQLite database.
-- Keep the cloud ledger in step with workflow transitions and make retries safe.
create or replace function private.apply_business_record_inventory_effect()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  product_id_value uuid;
  destination_branch uuid;
  movement_quantity numeric(18,4) := 0;
  movement_kind public.stock_movement_type;
  reference_kind text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  if new.kind not in ('goods_receipt','purchase_return','stock_count','stock_transfer') then
    return new;
  end if;

  begin
    product_id_value := nullif(new.metadata->>'productId','')::uuid;
  exception when invalid_text_representation then
    return new;
  end;
  if product_id_value is null then return new; end if;

  if new.kind = 'goods_receipt' and new.status = 'posted' then
    movement_quantity := new.quantity;
    movement_kind := 'purchase';
  elsif new.kind = 'purchase_return' and new.status = 'posted' then
    movement_quantity := -abs(new.quantity);
    movement_kind := 'return_out';
  elsif new.kind = 'stock_count' and new.status = 'posted' then
    movement_quantity := new.quantity - coalesce(nullif(new.metadata->>'systemQuantity','')::numeric,0);
    movement_kind := 'adjustment';
  elsif new.kind = 'stock_transfer' and new.status = 'in_transit' then
    movement_quantity := -abs(new.quantity);
    movement_kind := 'transfer_out';
  elsif new.kind = 'stock_transfer' and new.status = 'received' then
    begin
      destination_branch := nullif(new.metadata->>'destinationBranchId','')::uuid;
    exception when invalid_text_representation then
      return new;
    end;
    if destination_branch is null then return new; end if;
    movement_quantity := abs(new.quantity);
    movement_kind := 'transfer_in';
  else
    return new;
  end if;

  if movement_quantity = 0 then return new; end if;
  reference_kind := new.kind || ':' || new.status;

  if exists (
    select 1 from public.inventory_movements
    where tenant_id = new.tenant_id
      and reference_type = reference_kind
      and reference_id = new.id
  ) then
    return new;
  end if;

  insert into public.inventory_movements(
    tenant_id, branch_id, product_id, movement_type, quantity,
    unit_cost_minor, reference_type, reference_id, occurred_at
  ) values (
    new.tenant_id,
    coalesce(destination_branch,new.branch_id),
    product_id_value,
    movement_kind,
    movement_quantity,
    coalesce(
      nullif(new.metadata->>'unitCostMinor','')::bigint,
      case when new.kind='goods_receipt' and new.quantity>0 then round(new.amount_minor/new.quantity)::bigint else null end
    ),
    reference_kind,
    new.id,
    new.updated_at
  );
  return new;
end;
$$;

drop trigger if exists apply_business_record_inventory_effect on public.business_records;
create trigger apply_business_record_inventory_effect
after insert or update of status on public.business_records
for each row execute function private.apply_business_record_inventory_effect();

commit;
