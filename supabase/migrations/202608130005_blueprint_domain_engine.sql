begin;

-- Dedicated domain projections replace “screen-only” generic metadata for the
-- accounting, inventory, catalog, and tax workflows required by the blueprint.
create table public.inventory_lots (
  id uuid primary key references public.business_records(id) on delete restrict,
  tenant_id uuid not null, business_id uuid not null, branch_id uuid not null,
  product_id uuid not null references public.products(id), lot_code text not null,
  quantity numeric not null check(quantity>=0), unit_cost_minor bigint not null default 0 check(unit_cost_minor>=0),
  received_at date, expires_at date, status text not null check(status in ('available','quarantined','expired')),
  unique(branch_id,product_id,lot_code)
);
create table public.catalog_components (
  parent_record_id uuid not null references public.business_records(id) on delete cascade,
  tenant_id uuid not null, component_product_id uuid not null references public.products(id),
  quantity numeric not null check(quantity>0), unit text not null,
  component_type text not null check(component_type in ('bundle','recipe')),
  primary key(parent_record_id,component_product_id)
);
create table public.price_list_items (
  id uuid primary key references public.business_records(id) on delete restrict,
  tenant_id uuid not null, business_id uuid not null, branch_id uuid not null,
  product_id uuid not null references public.products(id), customer_segment_id uuid,
  minimum_quantity numeric not null default 1 check(minimum_quantity>0), price_minor bigint not null check(price_minor>=0),
  effective_from date not null, effective_until date, status text not null
);
create table public.subledger_documents (
  id uuid primary key references public.business_records(id) on delete restrict,
  tenant_id uuid not null, business_id uuid not null, branch_id uuid not null,
  document_type text not null check(document_type in ('receivable','payable')),
  partner_id uuid, original_minor bigint not null check(original_minor>=0),
  settled_minor bigint not null default 0 check(settled_minor>=0), due_at date,
  status text not null, check(settled_minor<=original_minor)
);
create table public.fixed_assets (
  id uuid primary key references public.business_records(id) on delete restrict,
  tenant_id uuid not null, business_id uuid not null, branch_id uuid not null,
  name text not null, acquired_at date not null, acquisition_minor bigint not null check(acquisition_minor>=0),
  residual_minor bigint not null default 0 check(residual_minor>=0), useful_life_months integer not null check(useful_life_months>0),
  asset_account text not null, accumulated_account text not null, expense_account text not null default '6201',
  status text not null check(status in ('draft','active','disposed')), check(residual_minor<=acquisition_minor)
);
create table public.depreciation_postings (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, business_id uuid not null,
  asset_id uuid not null references public.fixed_assets(id), period_date date not null,
  amount_minor bigint not null check(amount_minor>0), journal_entry_id uuid references public.journal_entries(id),
  created_at timestamptz not null default now(), unique(asset_id,period_date)
);
create table public.tax_policies (
  id uuid primary key references public.business_records(id) on delete restrict,
  tenant_id uuid not null, business_id uuid not null, code text not null,
  rate numeric(8,4) not null check(rate>=0 and rate<=100), calculation text not null check(calculation in ('inclusive','exclusive')),
  effective_from date not null, effective_until date, policy_version integer not null default 1 check(policy_version>0),
  tax_account text not null, coretax_mapping jsonb not null default '{}'::jsonb,
  status text not null, unique(business_id,code,policy_version)
);
create table public.sync_conflict_reviews (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, branch_id uuid not null,
  mutation_id uuid not null unique, aggregate_type text not null, aggregate_id uuid not null,
  local_payload jsonb not null, server_payload jsonb, error_code text not null,
  status text not null default 'requires_review' check(status in ('requires_review','resolved_correction','resolved_server_kept')),
  created_at timestamptz not null default now(), resolved_at timestamptz, resolved_by uuid
);

do $$ declare table_name text; begin
  foreach table_name in array array['inventory_lots','catalog_components','price_list_items','subledger_documents','fixed_assets','depreciation_postings','tax_policies','sync_conflict_reviews'] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('create policy %I on public.%I for select using (exists(select 1 from public.memberships m where m.tenant_id=%I.tenant_id and m.user_id=auth.uid() and m.active))','read_'||table_name,table_name,table_name);
  end loop;
end $$;

create or replace function private.project_blueprint_business_record()
returns trigger language plpgsql security definer set search_path='' as $$
declare component jsonb; product uuid;
begin
  if new.kind='lot' then
    product:=(new.metadata->>'productId')::uuid;
    insert into public.inventory_lots(id,tenant_id,business_id,branch_id,product_id,lot_code,quantity,unit_cost_minor,received_at,expires_at,status)
    values(new.id,new.tenant_id,new.business_id,new.branch_id,product,coalesce(new.code,new.id::text),new.quantity,
      coalesce((new.metadata->>'costMinor')::bigint,0),nullif(new.metadata->>'receivedAt','')::date,new.due_at::date,new.status)
    on conflict(id) do update set quantity=excluded.quantity,unit_cost_minor=excluded.unit_cost_minor,expires_at=excluded.expires_at,status=excluded.status;
  elsif new.kind in ('bundle','recipe') then
    delete from public.catalog_components where parent_record_id=new.id;
    for component in select * from jsonb_array_elements(coalesce(new.metadata -> (case when new.kind='bundle' then 'components' else 'ingredients' end),'[]'::jsonb)) loop
      insert into public.catalog_components(parent_record_id,tenant_id,component_product_id,quantity,unit,component_type)
      values(new.id,new.tenant_id,(component->>'productId')::uuid,(component->>'quantity')::numeric,coalesce(component->>'unit','pcs'),new.kind);
    end loop;
  elsif new.kind='price_list' then
    insert into public.price_list_items(id,tenant_id,business_id,branch_id,product_id,customer_segment_id,minimum_quantity,price_minor,effective_from,effective_until,status)
    values(new.id,new.tenant_id,new.business_id,new.branch_id,(new.metadata->>'productId')::uuid,
      nullif(new.metadata->>'customerSegmentId','')::uuid,greatest(new.quantity,1),new.amount_minor,
      (new.metadata->>'effectiveFrom')::date,new.due_at::date,new.status)
    on conflict(id) do update set minimum_quantity=excluded.minimum_quantity,price_minor=excluded.price_minor,effective_from=excluded.effective_from,effective_until=excluded.effective_until,status=excluded.status;
  elsif new.kind in ('receivable','payable') then
    insert into public.subledger_documents(id,tenant_id,business_id,branch_id,document_type,partner_id,original_minor,settled_minor,due_at,status)
    values(new.id,new.tenant_id,new.business_id,new.branch_id,new.kind,
      nullif(coalesce(new.metadata->>'customerId',new.metadata->>'supplierId'),'')::uuid,new.amount_minor,
      coalesce((new.metadata->>case when new.kind='receivable' then 'receivedMinor' else 'paidMinor' end)::bigint,0),new.due_at::date,new.status)
    on conflict(id) do update set settled_minor=excluded.settled_minor,due_at=excluded.due_at,status=excluded.status;
  elsif new.kind='asset' then
    insert into public.fixed_assets(id,tenant_id,business_id,branch_id,name,acquired_at,acquisition_minor,residual_minor,useful_life_months,asset_account,accumulated_account,status)
    values(new.id,new.tenant_id,new.business_id,new.branch_id,new.title,new.due_at::date,new.amount_minor,
      coalesce((new.metadata->>'residualMinor')::bigint,0),(new.metadata->>'usefulLifeMonths')::integer,
      coalesce(nullif(new.metadata->>'assetAccount',''),'1501'),coalesce(nullif(new.metadata->>'depreciationAccount',''),'1601'),new.status)
    on conflict(id) do update set name=excluded.name,residual_minor=excluded.residual_minor,useful_life_months=excluded.useful_life_months,status=excluded.status;
  elsif new.kind='tax' then
    insert into public.tax_policies(id,tenant_id,business_id,code,rate,calculation,effective_from,policy_version,tax_account,status)
    values(new.id,new.tenant_id,new.business_id,coalesce(new.code,new.id::text),(new.metadata->>'rate')::numeric,
      coalesce(new.metadata->>'calculation','exclusive'),(new.metadata->>'effectiveFrom')::date,
      coalesce((new.metadata->>'policyVersion')::integer,1),coalesce(nullif(new.metadata->>'taxAccount',''),'2103'),new.status)
    on conflict(id) do update set rate=excluded.rate,calculation=excluded.calculation,effective_from=excluded.effective_from,status=excluded.status;
    update public.tax_policies set coretax_mapping=jsonb_build_object('code',new.metadata->>'coretaxCode') where id=new.id;
  end if;
  return new;
exception when invalid_text_representation or not_null_violation then
  raise exception 'invalid_domain_projection:%',new.kind;
end;
$$;

drop trigger if exists project_blueprint_business_record on public.business_records;
create trigger project_blueprint_business_record after insert or update on public.business_records
for each row execute function private.project_blueprint_business_record();

-- The final permission rule mirrors the mobile role matrix: finance may perform
-- accounting transitions, while owner-only device and staff controls remain so.
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
  if new.kind=any(array['manual_journal','fiscal_period','tax','asset'])
    and actor_role not in ('owner','finance') then raise exception 'accounting_permission_denied'; end if;
  if new.kind=any(array['staff','device','hardware'])
    and actor_role<>'owner' then raise exception 'owner_approval_required'; end if;
  if new.status=any(array['approved','posted','paid','hard_closed','reversed','revoked','supported'])
    and actor_role='cashier' then raise exception 'supervisor_approval_required'; end if;
  new.metadata:=jsonb_set(coalesce(new.metadata,'{}'::jsonb),'{serverTransition}',
    jsonb_build_object('from',old.status,'to',new.status,'actorId',auth.uid(),'occurredAt',now()),true);
  return new;
end;
$$;

create or replace function private.post_multiline_manual_journal()
returns trigger language plpgsql security definer set search_path='' as $$
declare entry_id uuid; line jsonb; debit_total bigint:=0; credit_total bigint:=0;
begin
  if old.status=new.status or new.kind<>'manual_journal' or new.status<>'posted' then return new; end if;
  if jsonb_array_length(coalesce(new.metadata->'journalLines','[]'::jsonb))<2 then raise exception 'journal_requires_two_lines'; end if;
  for line in select * from jsonb_array_elements(new.metadata->'journalLines') loop
    debit_total:=debit_total+coalesce((line->>'debitMinor')::bigint,0);
    credit_total:=credit_total+coalesce((line->>'creditMinor')::bigint,0);
  end loop;
  if debit_total<=0 or debit_total<>credit_total then raise exception 'journal_not_balanced'; end if;
  insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
  values(new.tenant_id,new.business_id,'workflow:manual_journal:posted',new.id,coalesce(new.metadata->>'explanation',new.title),'posted',now(),auth.uid())
  on conflict(tenant_id,source_type,source_id) do nothing returning id into entry_id;
  if entry_id is null then return new; end if;
  for line in select * from jsonb_array_elements(new.metadata->'journalLines') loop
    insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description)
    values(new.tenant_id,entry_id,line->>'accountCode',coalesce((line->>'debitMinor')::bigint,0),coalesce((line->>'creditMinor')::bigint,0),line->>'description');
  end loop;
  return new;
end;
$$;

drop trigger if exists post_multiline_manual_journal on public.business_records;
create trigger post_multiline_manual_journal after update of status on public.business_records
for each row execute function private.post_multiline_manual_journal();

create or replace function public.run_monthly_depreciation(target_business uuid, period_end date)
returns integer language plpgsql security definer set search_path='' as $$
declare asset public.fixed_assets%rowtype; amount bigint; entry_id uuid; posting_id uuid; posted integer:=0;
begin
  if not exists(select 1 from public.memberships m join public.businesses b on b.tenant_id=m.tenant_id
    where b.id=target_business and m.user_id=auth.uid() and m.active and m.role in ('owner','finance')) then
    raise exception 'accounting_permission_denied';
  end if;
  for asset in select * from public.fixed_assets a where a.business_id=target_business and a.status='active' and a.acquired_at<=period_end loop
    if exists(select 1 from public.depreciation_postings d where d.asset_id=asset.id and d.period_date=period_end) then continue; end if;
    amount:=greatest(1,round((asset.acquisition_minor-asset.residual_minor)::numeric/asset.useful_life_months));
    entry_id:=gen_random_uuid();
    posting_id:=gen_random_uuid();
    insert into public.journal_entries(id,tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
    values(entry_id,asset.tenant_id,asset.business_id,'asset_depreciation',posting_id,'Penyusutan '||asset.name,'posted',period_end::timestamptz,auth.uid());
    insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
      (asset.tenant_id,entry_id,asset.expense_account,amount,0,'Beban penyusutan'),
      (asset.tenant_id,entry_id,asset.accumulated_account,0,amount,'Akumulasi penyusutan');
    insert into public.depreciation_postings(id,tenant_id,business_id,asset_id,period_date,amount_minor,journal_entry_id)
    values(posting_id,asset.tenant_id,asset.business_id,asset.id,period_end,amount,entry_id);
    posted:=posted+1;
  end loop;
  return posted;
end;
$$;

create or replace function public.export_tax_reconciliation(target_business uuid, date_from date, date_until date)
returns table(policy_code text,policy_version integer,coretax_code text,tax_base_minor bigint,tax_minor bigint)
language sql security invoker set search_path='' as $$
  select p.code,p.policy_version,p.coretax_mapping->>'code',
    coalesce(sum(s.subtotal_minor-s.discount_minor),0)::bigint,coalesce(sum(s.tax_minor),0)::bigint
  from public.tax_policies p left join public.sales s on s.business_id=p.business_id
    and s.status='paid' and s.occurred_at::date between date_from and date_until
    and s.occurred_at::date>=p.effective_from and (p.effective_until is null or s.occurred_at::date<=p.effective_until)
  where p.business_id=target_business and p.status='active'
  group by p.code,p.policy_version,p.coretax_mapping;
$$;

commit;
