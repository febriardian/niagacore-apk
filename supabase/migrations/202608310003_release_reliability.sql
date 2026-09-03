begin;

-- Persist rejected direct mutations so the mobile health screen reports server
-- facts instead of assuming that every request is healthy.
create table public.sync_failure_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null,
  device_id uuid not null,
  mutation_id uuid not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  error_code text not null,
  status text not null default 'requires_review'
    check(status in ('requires_review','resolved_server_kept')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  foreign key(tenant_id,device_id) references public.devices(tenant_id,id),
  unique(tenant_id,mutation_id)
);
alter table public.sync_failure_events enable row level security;
create policy sync_failure_events_read on public.sync_failure_events
for select to authenticated using(private.can_access_branch(tenant_id,branch_id));
grant select on public.sync_failure_events to authenticated;

create or replace function public.record_sync_review(
  client_device_id uuid,
  mutation jsonb,
  receipt_status text,
  receipt_error_code text
) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); tenant uuid; branch uuid;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  tenant:=(mutation->>'tenantId')::uuid;
  branch:=(mutation->>'branchId')::uuid;
  if (mutation->>'actorId')::uuid<>actor or (mutation->>'deviceId')::uuid<>client_device_id then
    raise exception 'actor_or_device_mismatch';
  end if;
  if not exists(select 1 from public.devices d where d.id=client_device_id and d.tenant_id=tenant and d.branch_id=branch and d.status='active')
    or not private.can_access_branch(tenant,branch) then raise exception 'device_or_branch_access_denied'; end if;
  if receipt_status='conflict' then
    insert into public.sync_conflict_reviews(tenant_id,branch_id,mutation_id,aggregate_type,aggregate_id,local_payload,error_code)
    values(tenant,branch,(mutation->>'mutationId')::uuid,mutation->>'aggregateType',(mutation->>'aggregateId')::uuid,
      coalesce(mutation->'payload','{}'::jsonb),left(coalesce(receipt_error_code,'version_conflict'),200))
    on conflict(mutation_id) do update set error_code=excluded.error_code;
  elsif receipt_status='rejected' then
    insert into public.sync_failure_events(tenant_id,branch_id,device_id,mutation_id,aggregate_type,aggregate_id,error_code)
    values(tenant,branch,client_device_id,(mutation->>'mutationId')::uuid,mutation->>'aggregateType',
      (mutation->>'aggregateId')::uuid,left(coalesce(receipt_error_code,'server_rejected_mutation'),200))
    on conflict(tenant_id,mutation_id) do update set error_code=excluded.error_code;
  end if;
end $$;

create or replace function public.resolve_sync_review(target_kind text,target_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); tenant uuid; branch uuid;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  if target_kind='conflict' then
    select tenant_id,branch_id into tenant,branch from public.sync_conflict_reviews where id=target_id and status='requires_review' for update;
    if tenant is null or not private.can_access_branch(tenant,branch) then raise exception 'sync_review_not_found'; end if;
    update public.sync_conflict_reviews set status='resolved_server_kept',resolved_at=now(),resolved_by=actor where id=target_id;
  elsif target_kind='failure' then
    select tenant_id,branch_id into tenant,branch from public.sync_failure_events where id=target_id and status='requires_review' for update;
    if tenant is null or not private.can_access_branch(tenant,branch) then raise exception 'sync_review_not_found'; end if;
    update public.sync_failure_events set status='resolved_server_kept',resolved_at=now(),resolved_by=actor where id=target_id;
  else raise exception 'invalid_sync_review_kind'; end if;
end $$;

revoke all on function public.record_sync_review(uuid,jsonb,text,text),public.resolve_sync_review(text,uuid) from public,anon;
grant execute on function public.record_sync_review(uuid,jsonb,text,text),public.resolve_sync_review(text,uuid) to authenticated;

-- Store the QR payload server-side so a pending payment can be recovered after
-- process death or a device restart without a transaction database on mobile.
create or replace function public.attach_qris_payment_session(
  target_sale_id uuid,
  target_order_id text,
  target_qr_string text,
  target_qr_image_url text,
  target_expires_at timestamptz,
  target_provider_payload jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); sale public.sales%rowtype;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  select * into sale from public.sales where id=target_sale_id and cashier_id=actor and status='pending_payment' for update;
  if sale.id is null or not private.can_access_branch(sale.tenant_id,sale.branch_id) then raise exception 'pending_sale_not_found'; end if;
  if target_expires_at<=now() or target_expires_at>now()+interval '30 minutes' then raise exception 'invalid_qris_expiry'; end if;
  update public.payments set provider_reference=target_order_id,
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
      'qrisSession',jsonb_build_object('qrString',target_qr_string,'qrImageUrl',target_qr_image_url,'expiresAt',target_expires_at),
      'providerCreate',coalesce(target_provider_payload,'{}'::jsonb)
    )
  where tenant_id=sale.tenant_id and sale_id=sale.id and method='qris';
  if not found then raise exception 'pending_payment_not_found'; end if;
end $$;

create or replace function public.get_recoverable_qris_payment(target_branch_id uuid,target_device_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); sale public.sales%rowtype; payment public.payments%rowtype; session jsonb; customer_name text;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  select s.* into sale from public.sales s
  join public.payments candidate on candidate.tenant_id=s.tenant_id and candidate.sale_id=s.id and candidate.method='qris'
  where s.branch_id=target_branch_id and s.device_id=target_device_id and s.cashier_id=actor
    and s.status='pending_payment' and candidate.metadata ? 'qrisSession'
    and private.can_access_branch(s.tenant_id,s.branch_id)
  order by s.created_at desc limit 1;
  if sale.id is null then return null; end if;
  select p.* into payment from public.payments p where p.tenant_id=sale.tenant_id and p.sale_id=sale.id and p.method='qris' limit 1;
  session:=coalesce(payment.metadata->'qrisSession','{}'::jsonb);
  if session='{}'::jsonb then return null; end if;
  select c.name into customer_name from public.customers c where c.tenant_id=sale.tenant_id and c.id=sale.customer_id;
  return jsonb_build_object(
    'saleId',sale.id,'orderId',coalesce(payment.provider_reference,sale.id::text),'receiptNumber',sale.receipt_number,
    'amount',sale.total_minor,'qrString',session->>'qrString','qrImageUrl',session->>'qrImageUrl','expiresAt',session->>'expiresAt',
    'providerStatus',payment.provider_status,
    'payload',jsonb_build_object(
      'customerName',customer_name,
      'lines',coalesce((select jsonb_agg(jsonb_build_object('productId',i.product_id,'quantity',i.quantity,'discountMinor',i.discount_minor) order by i.id)
        from public.sale_items i where i.tenant_id=sale.tenant_id and i.sale_id=sale.id),'[]'::jsonb)
    )
  );
end $$;

revoke all on function public.attach_qris_payment_session(uuid,text,text,text,timestamptz,jsonb),public.get_recoverable_qris_payment(uuid,uuid) from public,anon;
grant execute on function public.attach_qris_payment_session(uuid,text,text,text,timestamptz,jsonb),public.get_recoverable_qris_payment(uuid,uuid) to authenticated;

-- A dedicated registry keeps compatibility claims auditable. A profile cannot
-- be marked supported without physical-test metadata.
create table public.hardware_profiles(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null, branch_id uuid, kind text not null check(kind in('printer','scanner','cash_drawer','scale')),
  vendor text not null, model text not null, connection_type text not null check(connection_type in('bluetooth','usb','network','hid')),
  protocol text not null, paper_width_mm integer, code_page text, capabilities text[] not null default '{}',
  android_versions_tested text[] not null default '{}', firmware text, known_issues text[] not null default '{}',
  status text not null default 'experimental' check(status in('experimental','supported','deprecated')),
  tested_at timestamptz, test_evidence text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(tenant_id,business_id) references public.businesses(tenant_id,id),
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  check(status<>'supported' or (tested_at is not null and cardinality(android_versions_tested)>0 and length(coalesce(test_evidence,''))>=8)),
  unique(tenant_id,business_id,branch_id,kind,vendor,model,connection_type)
);
alter table public.hardware_profiles enable row level security;
create policy hardware_profiles_read on public.hardware_profiles for select to authenticated
using(private.is_tenant_member(tenant_id));
grant select on public.hardware_profiles to authenticated;

commit;
