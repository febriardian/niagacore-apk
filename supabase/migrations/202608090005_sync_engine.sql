begin;

create or replace function public.apply_sync_batch(client_device_id uuid, mutations jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  m jsonb; receipt jsonb; receipts jsonb := '[]'::jsonb;
  membership public.memberships%rowtype;
  p jsonb; line jsonb; total_cost bigint; net_revenue bigint; entry_id uuid;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  if jsonb_typeof(mutations) <> 'array' or jsonb_array_length(mutations) > 100 then raise exception 'invalid_batch'; end if;

  for m in select value from jsonb_array_elements(mutations)
  loop
    begin
      if (m->>'actorId')::uuid <> actor or (m->>'deviceId')::uuid <> client_device_id then raise exception 'actor_or_device_mismatch'; end if;
      select * into membership from public.memberships
        where tenant_id=(m->>'tenantId')::uuid and user_id=actor and active limit 1;
      if membership.id is null then raise exception 'tenant_access_denied'; end if;
      if not exists(select 1 from public.devices where id=client_device_id and tenant_id=membership.tenant_id and status='active') then
        raise exception 'device_not_active';
      end if;
      if exists(select 1 from public.sync_mutations where mutation_id=(m->>'mutationId')::uuid
        or (tenant_id=membership.tenant_id and idempotency_key=m->>'idempotencyKey')) then
        receipts := receipts || jsonb_build_array(jsonb_build_object('mutationId',m->>'mutationId','status','duplicate'));
        continue;
      end if;
      p := m->'payload';

      if m->>'aggregateType'<>'fiscal_period' and exists(
        select 1 from public.business_records period
        where period.tenant_id=membership.tenant_id
          and period.business_id=(m->>'businessId')::uuid
          and period.kind='fiscal_period' and period.active and period.status='hard_closed'
          and (m->>'occurredAt')::timestamptz::date between
            coalesce(nullif(period.metadata->>'startDate','')::date,period.due_at)
            and period.due_at
      ) then raise exception 'fiscal_period_closed'; end if;

      if m->>'aggregateType' = 'product' then
        if membership.role not in ('owner','supervisor') then raise exception 'permission_denied'; end if;
        insert into public.products(id,tenant_id,business_id,sku,barcode,name,category,price_minor,cost_minor,unit,tax_rate,
          product_type,description,image_path,track_stock,allow_negative,metadata,active,version)
        values((m->>'aggregateId')::uuid,membership.tenant_id,(m->>'businessId')::uuid,p->>'sku',nullif(p->>'barcode',''),
          p->>'name',coalesce(nullif(p->>'category',''),'Umum'),(p->>'priceMinor')::bigint,coalesce((p->>'costMinor')::bigint,0),
          coalesce(nullif(p->>'unit',''),'pcs'),coalesce((p->>'taxRate')::numeric,0),
          coalesce(nullif(p->>'productType',''),'goods'),nullif(p->>'description',''),nullif(p->>'imageUri',''),
          coalesce((p->>'trackStock')::boolean,true),coalesce((p->>'allowNegative')::boolean,false),
          coalesce(p->'metadata','{}'::jsonb),true,1)
        on conflict(id) do update set sku=excluded.sku,barcode=excluded.barcode,name=excluded.name,
          category=excluded.category,price_minor=excluded.price_minor,cost_minor=excluded.cost_minor,
          unit=excluded.unit,tax_rate=excluded.tax_rate,product_type=excluded.product_type,
          description=excluded.description,image_path=excluded.image_path,track_stock=excluded.track_stock,
          allow_negative=excluded.allow_negative,metadata=excluded.metadata,
          version=public.products.version+1,updated_at=now()
        where public.products.tenant_id=membership.tenant_id
          and (m->>'baseVersion' is null or public.products.version=(m->>'baseVersion')::bigint);
        if not found then raise exception 'product_version_conflict'; end if;
        if m->>'operation'='create' and coalesce((p->>'openingStock')::numeric,0)<>0 then
          insert into public.inventory_movements(tenant_id,branch_id,product_id,movement_type,quantity,unit_cost_minor,reference_type,reference_id,occurred_at)
          values(membership.tenant_id,(m->>'branchId')::uuid,(m->>'aggregateId')::uuid,'opening',(p->>'openingStock')::numeric,
            coalesce((p->>'costMinor')::bigint,0),'product',(m->>'aggregateId')::uuid,(m->>'occurredAt')::timestamptz);
        end if;
      elsif m->>'aggregateType' = 'customer' then
        insert into public.customers(id,tenant_id,name,phone,email,version)
        values((m->>'aggregateId')::uuid,membership.tenant_id,p->>'name',nullif(p->>'phone',''),nullif(p->>'email',''),1)
        on conflict(id) do update set name=excluded.name,phone=excluded.phone,email=excluded.email,
          version=public.customers.version+1,updated_at=now() where public.customers.tenant_id=membership.tenant_id;
      elsif m->>'aggregateType' = 'expense' then
        if membership.role not in ('owner','supervisor') then raise exception 'permission_denied'; end if;
        insert into public.expenses(id,tenant_id,branch_id,category,description,amount_minor,payment_source,occurred_at,created_by)
        values((m->>'aggregateId')::uuid,membership.tenant_id,(m->>'branchId')::uuid,p->>'category',p->>'description',
          (p->>'amountMinor')::bigint,p->>'paymentSource',(m->>'occurredAt')::timestamptz,actor);
      elsif m->>'aggregateType' = 'partner' then
        if membership.role not in ('owner','supervisor') then raise exception 'permission_denied'; end if;
        insert into public.partners(id,tenant_id,kind,name,phone,email,address,tax_id)
        values((m->>'aggregateId')::uuid,membership.tenant_id,coalesce(nullif(p->>'kind',''),'supplier'),p->>'name',
          nullif(p->>'phone',''),nullif(p->>'email',''),nullif(p->>'address',''),nullif(p->>'taxId',''));
      elsif m->>'aggregateType' = 'appointment' then
        insert into public.appointments(id,tenant_id,branch_id,customer_id,service_name,staff_name,starts_at,duration_minutes,status,notes)
        values((m->>'aggregateId')::uuid,membership.tenant_id,(m->>'branchId')::uuid,nullif(p->>'customerId','')::uuid,
          p->>'serviceName',nullif(p->>'staffName',''),(p->>'startsAt')::timestamptz,coalesce((p->>'durationMinutes')::integer,60),
          coalesce(nullif(p->>'status',''),'scheduled'),nullif(p->>'notes',''));
      elsif m->>'aggregateType' = 'dining_table' then
        if membership.role not in ('owner','supervisor') then raise exception 'permission_denied'; end if;
        insert into public.dining_tables(id,tenant_id,branch_id,code,capacity,status)
        values((m->>'aggregateId')::uuid,membership.tenant_id,(m->>'branchId')::uuid,p->>'code',
          coalesce((p->>'capacity')::integer,2),coalesce(nullif(p->>'status',''),'available'));
      elsif m->>'aggregateType' = 'sale' then
        if p->>'paymentMethod' <> 'cash' then raise exception 'gateway_sale_requires_server_payment'; end if;
        if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then raise exception 'sale_lines_required'; end if;
        insert into public.sales(id,tenant_id,business_id,branch_id,device_id,cashier_id,customer_id,receipt_number,status,
          subtotal_minor,discount_minor,tax_minor,total_minor,paid_minor,payment_method,version,occurred_at)
        values((m->>'aggregateId')::uuid,membership.tenant_id,(m->>'businessId')::uuid,(m->>'branchId')::uuid,
          client_device_id,actor,nullif(p->>'customerId','')::uuid,p->>'receiptNumber','paid',(p->>'subtotalMinor')::bigint,
          coalesce((p->>'discountMinor')::bigint,0),(p->>'taxMinor')::bigint,(p->>'totalMinor')::bigint,(p->>'totalMinor')::bigint,'cash',1,
          (m->>'occurredAt')::timestamptz);
        total_cost := 0;
        for line in select value from jsonb_array_elements(p->'lines') loop
          insert into public.sale_items(tenant_id,sale_id,product_id,name,quantity,price_minor,cost_minor,discount_minor,tax_minor,total_minor)
          values(membership.tenant_id,(m->>'aggregateId')::uuid,(line->>'productId')::uuid,line->>'name',(line->>'quantity')::numeric,
            (line->>'priceMinor')::bigint,coalesce((line->>'costMinor')::bigint,0),coalesce((line->>'discountMinor')::bigint,0),
            coalesce((line->>'taxMinor')::bigint,0),(line->>'totalMinor')::bigint);
          insert into public.inventory_movements(tenant_id,branch_id,product_id,movement_type,quantity,unit_cost_minor,reference_type,reference_id,occurred_at)
          values(membership.tenant_id,(m->>'branchId')::uuid,(line->>'productId')::uuid,'sale',-(line->>'quantity')::numeric,
            coalesce((line->>'costMinor')::bigint,0),'sale',(m->>'aggregateId')::uuid,(m->>'occurredAt')::timestamptz);
          total_cost := total_cost + round((line->>'quantity')::numeric * coalesce((line->>'costMinor')::bigint,0));
        end loop;
        insert into public.payments(tenant_id,sale_id,method,amount_minor,paid_at)
          values(membership.tenant_id,(m->>'aggregateId')::uuid,'cash',(p->>'totalMinor')::bigint,(m->>'occurredAt')::timestamptz);
        insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
          values(membership.tenant_id,(m->>'businessId')::uuid,'sale',(m->>'aggregateId')::uuid,'Penjualan tunai','posted',(m->>'occurredAt')::timestamptz,actor)
          returning id into entry_id;
        net_revenue := (p->>'totalMinor')::bigint - (p->>'taxMinor')::bigint;
        insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
          (membership.tenant_id,entry_id,'1101',(p->>'totalMinor')::bigint,0,'Kas'),
          (membership.tenant_id,entry_id,'4101',0,net_revenue,'Penjualan');
        if (p->>'taxMinor')::bigint > 0 then
          insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description)
          values(membership.tenant_id,entry_id,'2103',0,(p->>'taxMinor')::bigint,'Pajak keluaran');
        end if;
        if total_cost > 0 then
          insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
            (membership.tenant_id,entry_id,'5101',total_cost,0,'HPP'),
            (membership.tenant_id,entry_id,'1301',0,total_cost,'Persediaan');
        end if;
      else
        raise exception 'unsupported_aggregate';
      end if;

      insert into public.sync_mutations(mutation_id,tenant_id,business_id,branch_id,device_id,actor_id,idempotency_key,
        aggregate_type,aggregate_id,operation,base_version,schema_version,payload,occurred_at)
      values((m->>'mutationId')::uuid,membership.tenant_id,(m->>'businessId')::uuid,(m->>'branchId')::uuid,client_device_id,
        actor,m->>'idempotencyKey',m->>'aggregateType',(m->>'aggregateId')::uuid,m->>'operation',nullif(m->>'baseVersion','')::bigint,
        (m->>'schemaVersion')::integer,p,(m->>'occurredAt')::timestamptz);
      receipts := receipts || jsonb_build_array(jsonb_build_object('mutationId',m->>'mutationId','status','accepted'));
    exception when others then
      receipts := receipts || jsonb_build_array(jsonb_build_object(
        'mutationId',m->>'mutationId',
        'status',case when sqlerrm like '%version_conflict%' then 'conflict' else 'rejected' end,
        'errorCode',sqlerrm));
    end;
  end loop;
  update public.devices set last_seen_at=now(),updated_at=now() where id=client_device_id;
  return jsonb_build_object('receipts',receipts,'serverTime',now());
end; $$;

revoke all on function public.apply_sync_batch(uuid,jsonb) from public;
grant execute on function public.apply_sync_batch(uuid,jsonb) to authenticated;

commit;
