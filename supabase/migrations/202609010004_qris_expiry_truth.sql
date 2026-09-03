begin;

create or replace function public.expire_stale_qris_payments(target_tenant_id uuid,target_branch_id uuid)
returns bigint language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); target_sales uuid[]; affected bigint:=0;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  if not private.can_access_branch(target_tenant_id,target_branch_id) then raise exception 'branch_access_denied'; end if;

  select coalesce(array_agg(s.id),'{}'::uuid[]) into target_sales
  from public.sales s
  join public.payments p on p.tenant_id=s.tenant_id and p.sale_id=s.id and p.method='qris'
  where s.tenant_id=target_tenant_id and s.branch_id=target_branch_id and s.status='pending_payment'
    and coalesce(p.provider_status,'pending') not in('capture','settlement')
    and case
      when coalesce(p.metadata->'qrisSession'->>'expiresAt','') ~ '^\d{4}-\d{2}-\d{2}T'
        then (p.metadata->'qrisSession'->>'expiresAt')::timestamptz
      else s.created_at+interval '15 minutes'
    end <= now();

  if cardinality(target_sales)=0 then return 0; end if;
  update public.payments p set provider_status='expire',metadata=coalesce(p.metadata,'{}'::jsonb)||jsonb_build_object('qrisExpiry',jsonb_build_object('expiredAt',now(),'source','session_timeout'))
    where p.tenant_id=target_tenant_id and p.sale_id=any(target_sales) and p.method='qris';
  update public.sales s set status='void',updated_at=now(),version=version+1
    where s.tenant_id=target_tenant_id and s.id=any(target_sales) and s.status='pending_payment';
  get diagnostics affected=row_count;
  return affected;
end $$;

revoke all on function public.expire_stale_qris_payments(uuid,uuid) from public,anon;
grant execute on function public.expire_stale_qris_payments(uuid,uuid) to authenticated;

create or replace function public.get_recoverable_qris_payment(target_branch_id uuid,target_device_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); sale public.sales%rowtype; payment public.payments%rowtype; session jsonb; customer_name text;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  select s.* into sale from public.sales s
  join public.payments candidate on candidate.tenant_id=s.tenant_id and candidate.sale_id=s.id and candidate.method='qris'
  where s.branch_id=target_branch_id and s.device_id=target_device_id and s.cashier_id=actor
    and s.status='pending_payment' and candidate.metadata ? 'qrisSession'
    and coalesce(nullif(candidate.metadata->'qrisSession'->>'expiresAt','')::timestamptz,s.created_at+interval '15 minutes')>now()
    and private.can_access_branch(s.tenant_id,s.branch_id)
  order by s.created_at desc limit 1;
  if sale.id is null then return null; end if;
  select p.* into payment from public.payments p where p.tenant_id=sale.tenant_id and p.sale_id=sale.id and p.method='qris' limit 1;
  session:=coalesce(payment.metadata->'qrisSession','{}'::jsonb);
  if session='{}'::jsonb then return null; end if;
  select c.name into customer_name from public.customers c where c.tenant_id=sale.tenant_id and c.id=sale.customer_id;
  return jsonb_build_object('saleId',sale.id,'orderId',coalesce(payment.provider_reference,sale.id::text),'receiptNumber',sale.receipt_number,
    'amount',sale.total_minor,'qrString',session->>'qrString','qrImageUrl',session->>'qrImageUrl','paymentUrl',session->>'paymentUrl','expiresAt',session->>'expiresAt','providerStatus',payment.provider_status,
    'payload',jsonb_build_object('customerName',customer_name,'lines',coalesce((select jsonb_agg(jsonb_build_object('productId',i.product_id,'quantity',i.quantity,'discountMinor',i.discount_minor) order by i.id) from public.sale_items i where i.tenant_id=sale.tenant_id and i.sale_id=sale.id),'[]'::jsonb)));
end $$;

comment on function public.expire_stale_qris_payments(uuid,uuid) is 'Closes unpaid QRIS sessions after their authoritative 15-minute payment window.';
commit;
