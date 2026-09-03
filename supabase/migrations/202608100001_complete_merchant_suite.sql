begin;

alter table public.products add column if not exists product_type text not null default 'goods';
alter table public.products add column if not exists description text;
alter table public.products add column if not exists image_path text;
alter table public.products add column if not exists track_stock boolean not null default true;
alter table public.products add column if not exists allow_negative boolean not null default false;
alter table public.products add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.business_records (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null,
  branch_id uuid not null,
  kind text not null,
  code text,
  title text not null check(char_length(title) between 2 and 200),
  subtitle text,
  status text not null default 'active',
  amount_minor bigint not null default 0,
  quantity numeric(18,4) not null default 0,
  due_at date,
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  version bigint not null default 0,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(tenant_id,business_id) references public.businesses(tenant_id,id),
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  unique(tenant_id,id)
);
create index if not exists business_records_scope_idx on public.business_records(tenant_id,branch_id,kind,active,updated_at desc);

create table if not exists public.shifts (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null,
  device_id uuid not null,
  user_id uuid not null references auth.users(id),
  opening_minor bigint not null default 0,
  closing_minor bigint,
  expected_minor bigint,
  variance_minor bigint,
  variance_reason text,
  status text not null check(status in ('open','closed')),
  opened_at timestamptz not null,
  closed_at timestamptz,
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  foreign key(tenant_id,device_id) references public.devices(tenant_id,id),
  unique(tenant_id,id)
);
create unique index if not exists one_open_shift_per_device on public.shifts(device_id) where status='open';

create table if not exists public.cash_movements (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null,
  shift_id uuid not null,
  direction text not null check(direction in ('in','out')),
  category text not null,
  amount_minor bigint not null check(amount_minor>0),
  note text,
  actor_id uuid not null references auth.users(id),
  occurred_at timestamptz not null,
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  foreign key(tenant_id,shift_id) references public.shifts(tenant_id,id),
  unique(tenant_id,id)
);

create table if not exists public.refunds (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null,
  branch_id uuid not null,
  sale_id uuid not null,
  amount_minor bigint not null check(amount_minor>0),
  reason text not null,
  stock_disposition text not null check(stock_disposition in ('restock','damaged')),
  status text not null check(status in ('pending','approved','rejected','posted')),
  requested_by uuid not null references auth.users(id),
  approved_by uuid references auth.users(id),
  occurred_at timestamptz not null,
  foreign key(tenant_id,business_id) references public.businesses(tenant_id,id),
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  foreign key(tenant_id,sale_id) references public.sales(tenant_id,id),
  unique(tenant_id,id)
);

create table if not exists public.accounting_settings (
  business_id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tax_profile text not null default 'non_pkp' check(tax_profile in ('non_pkp','pkp')),
  ppn_enabled boolean not null default false,
  ppn_rate numeric(5,2) not null default 11,
  inventory_costing text not null default 'moving_average' check(inventory_costing in ('moving_average','fifo')),
  rounding_policy text not null default 'nearest',
  fiscal_year_start smallint not null default 1 check(fiscal_year_start between 1 and 12),
  negative_stock_policy text not null default 'approval' check(negative_stock_policy in ('blocked','approval','allowed')),
  cloud_ai_enabled boolean not null default true,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  foreign key(tenant_id,business_id) references public.businesses(tenant_id,id)
);
alter table public.accounting_settings add column if not exists negative_stock_policy text not null default 'approval';
alter table public.accounting_settings add column if not exists cloud_ai_enabled boolean not null default true;

create table if not exists public.approval_requests (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null,
  kind text not null,
  resource_id uuid,
  requested_by uuid not null references auth.users(id),
  approver_id uuid references auth.users(id),
  reason text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  unique(tenant_id,id)
);

do $$ declare t text; begin
  foreach t in array array['business_records','shifts','cash_movements','refunds','accounting_settings','approval_requests'] loop
    execute format('alter table public.%I enable row level security',t);
    if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_select_member') then
      execute format('create policy %I on public.%I for select to authenticated using (private.is_tenant_member(tenant_id))',t||'_select_member',t);
    end if;
  end loop;
end $$;

create or replace function private.post_record_journal(
  target_tenant uuid,target_business uuid,target_source uuid,event_kind text,amount bigint,actor uuid,event_time timestamptz
) returns void language plpgsql security definer set search_path='' as $$
declare entry_id uuid; debit_code text; credit_code text; memo_text text;
begin
  if amount<=0 or exists(select 1 from public.journal_entries where tenant_id=target_tenant and source_type=event_kind and source_id=target_source) then return; end if;
  case event_kind
    when 'expense' then debit_code:='6101';credit_code:='1101';memo_text:='Beban operasional';
    when 'goods_receipt' then debit_code:='1301';credit_code:='2101';memo_text:='Penerimaan barang';
    when 'supplier_bill' then debit_code:='1301';credit_code:='2101';memo_text:='Tagihan pemasok';
    when 'payable' then debit_code:='6101';credit_code:='2101';memo_text:='Utang usaha';
    when 'receivable' then debit_code:='1201';credit_code:='4101';memo_text:='Piutang usaha';
    when 'asset' then debit_code:='1501';credit_code:='1101';memo_text:='Perolehan aset';
    else return;
  end case;
  insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
  values(target_tenant,target_business,event_kind,target_source,memo_text,'posted',event_time,actor) returning id into entry_id;
  insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
    (target_tenant,entry_id,debit_code,amount,0,memo_text),(target_tenant,entry_id,credit_code,0,amount,memo_text);
end; $$;

create or replace function public.apply_extended_sync_batch(client_device_id uuid, mutations jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  m jsonb; p jsonb; receipts jsonb := '[]'::jsonb;
  membership public.memberships%rowtype;
  aggregate text; operation_name text; target_id uuid;
  sale_total bigint; refunded_total bigint; returned_cost bigint; refund_entry uuid; sale_line record;
  allowed_generic text[] := array['customer','expense','supplier','purchase_order','goods_receipt','supplier_bill',
    'purchase_return','payable','receivable','stock_count','stock_transfer','price_list','bundle','recipe',
    'modifier','lot','customer_segment','loyalty','service','appointment','dining_table','kitchen_order',
    'asset','manual_journal','fiscal_period','tax','staff','device','hardware','notification'];
begin
  if actor is null then raise exception 'authentication_required'; end if;
  if jsonb_typeof(mutations)<>'array' or jsonb_array_length(mutations)>100 then raise exception 'invalid_batch'; end if;
  for m in select value from jsonb_array_elements(mutations) loop
    begin
      if (m->>'actorId')::uuid<>actor or (m->>'deviceId')::uuid<>client_device_id then raise exception 'actor_or_device_mismatch'; end if;
      select * into membership from public.memberships where tenant_id=(m->>'tenantId')::uuid and user_id=actor and active limit 1;
      if membership.id is null then raise exception 'tenant_access_denied'; end if;
      if not exists(select 1 from public.devices where id=client_device_id and tenant_id=membership.tenant_id and status='active') then raise exception 'device_not_active'; end if;
      if exists(select 1 from public.sync_mutations where mutation_id=(m->>'mutationId')::uuid or (tenant_id=membership.tenant_id and idempotency_key=m->>'idempotencyKey')) then
        receipts:=receipts||jsonb_build_array(jsonb_build_object('mutationId',m->>'mutationId','status','duplicate'));continue;
      end if;
      aggregate:=m->>'aggregateType';operation_name:=m->>'operation';target_id:=(m->>'aggregateId')::uuid;p:=m->'payload';
      if aggregate<>'fiscal_period' and exists(
        select 1 from public.business_records period
        where period.tenant_id=membership.tenant_id
          and period.business_id=(m->>'businessId')::uuid
          and period.kind='fiscal_period' and period.active and period.status='hard_closed'
          and (m->>'occurredAt')::timestamptz::date between
            coalesce(nullif(period.metadata->>'startDate','')::date,period.due_at)
            and period.due_at
      ) then raise exception 'fiscal_period_closed'; end if;

      if aggregate='product' and operation_name='archive' then
        if membership.role not in ('owner','supervisor') then raise exception 'permission_denied'; end if;
        update public.products set active=false,version=version+1,updated_at=now() where id=target_id and tenant_id=membership.tenant_id;
      elsif aggregate='stock_adjustment' then
        if membership.role not in ('owner','supervisor') then raise exception 'permission_denied'; end if;
        insert into public.inventory_movements(id,tenant_id,branch_id,product_id,movement_type,quantity,reference_type,reference_id,occurred_at)
        values(target_id,membership.tenant_id,(m->>'branchId')::uuid,(p->>'productId')::uuid,'adjustment',(p->>'quantity')::numeric,'stock_adjustment',target_id,(m->>'occurredAt')::timestamptz);
      elsif aggregate='shift' then
        if operation_name='create' then
          insert into public.shifts(id,tenant_id,branch_id,device_id,user_id,opening_minor,status,opened_at)
          values(target_id,membership.tenant_id,(m->>'branchId')::uuid,client_device_id,actor,coalesce((p->>'openingMinor')::bigint,0),'open',(m->>'occurredAt')::timestamptz);
        else
          update public.shifts set closing_minor=(p->>'closingMinor')::bigint,variance_reason=nullif(p->>'reason',''),status='closed',closed_at=now()
          where id=target_id and tenant_id=membership.tenant_id and user_id=actor and status='open';
        end if;
      elsif aggregate='cash_movement' then
        insert into public.cash_movements(id,tenant_id,branch_id,shift_id,direction,category,amount_minor,note,actor_id,occurred_at)
        values(target_id,membership.tenant_id,(m->>'branchId')::uuid,(p->>'shiftId')::uuid,p->>'direction',p->>'category',(p->>'amountMinor')::bigint,nullif(p->>'note',''),actor,(m->>'occurredAt')::timestamptz);
      elsif aggregate='refund' then
        if coalesce((p->>'approved')::boolean,false) and membership.role='cashier' then raise exception 'approval_required'; end if;
        insert into public.refunds(id,tenant_id,business_id,branch_id,sale_id,amount_minor,reason,stock_disposition,status,requested_by,approved_by,occurred_at)
        values(target_id,membership.tenant_id,(m->>'businessId')::uuid,(m->>'branchId')::uuid,(p->>'saleId')::uuid,(p->>'amountMinor')::bigint,p->>'reason',p->>'stockDisposition',case when coalesce((p->>'approved')::boolean,false) then 'posted' else 'pending' end,actor,case when coalesce((p->>'approved')::boolean,false) then actor else null end,(m->>'occurredAt')::timestamptz);
        if coalesce((p->>'approved')::boolean,false) then
          select total_minor into sale_total from public.sales where id=(p->>'saleId')::uuid and tenant_id=membership.tenant_id;
          select coalesce(sum(amount_minor),0) into refunded_total from public.refunds
            where sale_id=(p->>'saleId')::uuid and tenant_id=membership.tenant_id and status='posted' and id<>target_id;
          if sale_total is null or (p->>'amountMinor')::bigint<=0 or refunded_total+(p->>'amountMinor')::bigint>sale_total then raise exception 'invalid_refund_amount'; end if;
          insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
          values(membership.tenant_id,(m->>'businessId')::uuid,'refund',target_id,'Retur penjualan','posted',(m->>'occurredAt')::timestamptz,actor) returning id into refund_entry;
          insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
            (membership.tenant_id,refund_entry,'4201',(p->>'amountMinor')::bigint,0,'Retur penjualan'),
            (membership.tenant_id,refund_entry,'1101',0,(p->>'amountMinor')::bigint,'Pengembalian kas');
          if refunded_total+(p->>'amountMinor')::bigint=sale_total then
            update public.sales set status='refunded',updated_at=now() where id=(p->>'saleId')::uuid and tenant_id=membership.tenant_id;
          end if;
          if p->>'stockDisposition'='restock' then
            returned_cost:=0;
            for sale_line in select product_id,quantity,cost_minor from public.sale_items where sale_id=(p->>'saleId')::uuid and tenant_id=membership.tenant_id loop
              insert into public.inventory_movements(tenant_id,branch_id,product_id,movement_type,quantity,unit_cost_minor,reference_type,reference_id,occurred_at)
              values(membership.tenant_id,(m->>'branchId')::uuid,sale_line.product_id,'return_in',sale_line.quantity*((p->>'amountMinor')::numeric/sale_total),sale_line.cost_minor,'refund',target_id,(m->>'occurredAt')::timestamptz);
              returned_cost:=returned_cost+round(sale_line.quantity*((p->>'amountMinor')::numeric/sale_total)*sale_line.cost_minor);
            end loop;
            if returned_cost>0 then
              insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
                (membership.tenant_id,refund_entry,'1301',returned_cost,0,'Persediaan kembali'),
                (membership.tenant_id,refund_entry,'5101',0,returned_cost,'Pembalikan HPP');
            end if;
          end if;
        end if;
      elsif aggregate='accounting_settings' then
        if membership.role<>'owner' then raise exception 'permission_denied'; end if;
        if coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'mfa_required'; end if;
        insert into public.accounting_settings(business_id,tenant_id,tax_profile,ppn_enabled,ppn_rate,inventory_costing,rounding_policy,fiscal_year_start,negative_stock_policy,cloud_ai_enabled,updated_by)
        values((m->>'businessId')::uuid,membership.tenant_id,p->>'taxProfile',(p->>'ppnEnabled')::boolean,(p->>'ppnRate')::numeric,p->>'inventoryCosting',coalesce(p->>'roundingPolicy','nearest'),coalesce((p->>'fiscalYearStart')::smallint,1),coalesce(p->>'negativeStockPolicy','approval'),coalesce((p->>'cloudAiEnabled')::boolean,true),actor)
        on conflict(business_id) do update set tax_profile=excluded.tax_profile,ppn_enabled=excluded.ppn_enabled,ppn_rate=excluded.ppn_rate,inventory_costing=excluded.inventory_costing,rounding_policy=excluded.rounding_policy,fiscal_year_start=excluded.fiscal_year_start,negative_stock_policy=excluded.negative_stock_policy,cloud_ai_enabled=excluded.cloud_ai_enabled,updated_by=actor,updated_at=now();
      elsif aggregate=any(allowed_generic) then
        if membership.role='cashier' and not aggregate=any(array['customer','appointment','dining_table','kitchen_order','loyalty','notification']) then raise exception 'permission_denied'; end if;
        if aggregate=any(array['manual_journal','fiscal_period','tax','asset','staff','device','hardware']) and membership.role<>'owner' then raise exception 'owner_approval_required'; end if;
        if aggregate=any(array['manual_journal','fiscal_period','tax','asset','staff','device','hardware']) and coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'mfa_required'; end if;
        if operation_name='archive' then
          if membership.role='cashier' then raise exception 'permission_denied'; end if;
          update public.business_records set active=false,version=version+1,updated_at=now()
          where id=target_id and tenant_id=membership.tenant_id;
          if not found then raise exception 'record_not_found'; end if;
        else
          if membership.role='cashier' and coalesce(p->>'status','')=any(array['approved','posted','paid','hard_closed','reversed','revoked','supported']) then raise exception 'approval_required'; end if;
          insert into public.business_records(id,tenant_id,business_id,branch_id,kind,code,title,subtitle,status,amount_minor,quantity,due_at,metadata,active,version,created_by)
          values(target_id,membership.tenant_id,(m->>'businessId')::uuid,(m->>'branchId')::uuid,aggregate,nullif(p->>'code',''),p->>'title',nullif(p->>'subtitle',''),coalesce(nullif(p->>'status',''),'active'),coalesce((p->>'amountMinor')::bigint,0),coalesce((p->>'quantity')::numeric,0),nullif(p->>'dueAt','')::date,coalesce(p->'metadata','{}'::jsonb),true,1,actor)
          on conflict(id) do update set code=excluded.code,title=excluded.title,subtitle=excluded.subtitle,status=excluded.status,amount_minor=excluded.amount_minor,quantity=excluded.quantity,due_at=excluded.due_at,metadata=excluded.metadata,active=true,version=public.business_records.version+1,updated_at=now()
          where public.business_records.tenant_id=membership.tenant_id
            and (m->>'baseVersion' is null or public.business_records.version=(m->>'baseVersion')::bigint);
          if not found then raise exception 'record_version_conflict'; end if;
          if aggregate='customer' then
            insert into public.customers(id,tenant_id,name,phone,email,version)
            values(target_id,membership.tenant_id,p->>'title',nullif(p->'metadata'->>'phone',''),nullif(p->'metadata'->>'email',''),1)
            on conflict(id) do update set name=excluded.name,phone=excluded.phone,email=excluded.email,
              version=public.customers.version+1,updated_at=now()
            where public.customers.tenant_id=membership.tenant_id;
          end if;
          if operation_name='create' and (coalesce(p->>'status','')='posted' or aggregate=any(array['payable','receivable'])) then
            perform private.post_record_journal(membership.tenant_id,(m->>'businessId')::uuid,target_id,aggregate,coalesce((p->>'amountMinor')::bigint,0),actor,(m->>'occurredAt')::timestamptz);
          end if;
        end if;
      else raise exception 'unsupported_aggregate';
      end if;

      insert into public.sync_mutations(mutation_id,tenant_id,business_id,branch_id,device_id,actor_id,idempotency_key,aggregate_type,aggregate_id,operation,base_version,schema_version,payload,occurred_at)
      values((m->>'mutationId')::uuid,membership.tenant_id,(m->>'businessId')::uuid,(m->>'branchId')::uuid,client_device_id,actor,m->>'idempotencyKey',aggregate,target_id,operation_name,nullif(m->>'baseVersion','')::bigint,(m->>'schemaVersion')::integer,p,(m->>'occurredAt')::timestamptz);
      insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result,metadata)
      values(membership.tenant_id,actor,client_device_id,'sync.'||operation_name,aggregate,target_id::text,'success',jsonb_build_object('mutationId',m->>'mutationId'));
      receipts:=receipts||jsonb_build_array(jsonb_build_object('mutationId',m->>'mutationId','status','accepted'));
    exception when others then
      receipts:=receipts||jsonb_build_array(jsonb_build_object(
        'mutationId',m->>'mutationId',
        'status',case when sqlerrm like '%version_conflict%' then 'conflict' else 'rejected' end,
        'errorCode',sqlerrm));
    end;
  end loop;
  update public.devices set last_seen_at=now(),updated_at=now() where id=client_device_id;
  return jsonb_build_object('receipts',receipts,'serverTime',now());
end; $$;

revoke all on function public.apply_extended_sync_batch(uuid,jsonb) from public;
grant execute on function public.apply_extended_sync_batch(uuid,jsonb) to authenticated;

-- Every new business receives the selected safe defaults. This is repeatable
-- and does not overwrite an owner's later configuration.
insert into public.accounting_settings(business_id,tenant_id,tax_profile,ppn_enabled,inventory_costing)
select id,tenant_id,'non_pkp',false,'moving_average' from public.businesses
on conflict(business_id) do nothing;

create or replace function private.seed_business_accounting_defaults()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.accounting_settings(business_id,tenant_id,tax_profile,ppn_enabled,inventory_costing)
  values(new.id,new.tenant_id,'non_pkp',false,'moving_average') on conflict(business_id) do nothing;
  return new;
end; $$;
drop trigger if exists seed_business_accounting_defaults on public.businesses;
create trigger seed_business_accounting_defaults after insert on public.businesses
for each row execute function private.seed_business_accounting_defaults();

commit;
