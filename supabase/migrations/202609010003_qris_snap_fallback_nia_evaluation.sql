begin;

create or replace function public.attach_qris_payment_session_v2(
  target_sale_id uuid,
  target_order_id text,
  target_qr_string text,
  target_qr_image_url text,
  target_payment_url text,
  target_expires_at timestamptz,
  target_provider_payload jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); sale public.sales%rowtype;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  select * into sale from public.sales where id=target_sale_id and cashier_id=actor and status='pending_payment' for update;
  if sale.id is null or not private.can_access_branch(sale.tenant_id,sale.branch_id) then raise exception 'pending_sale_not_found'; end if;
  if target_expires_at<=now() or target_expires_at>now()+interval '30 minutes' then raise exception 'invalid_qris_expiry'; end if;
  if coalesce(target_qr_string,'')='' and coalesce(target_qr_image_url,'')='' and coalesce(target_payment_url,'')='' then raise exception 'payment_presentation_missing'; end if;
  if coalesce(target_payment_url,'')<>'' and target_payment_url!~'^https://app\.midtrans\.com/' then raise exception 'invalid_midtrans_payment_url'; end if;
  update public.payments set provider_reference=target_order_id,
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
      'qrisSession',jsonb_build_object('qrString',target_qr_string,'qrImageUrl',target_qr_image_url,'paymentUrl',target_payment_url,'expiresAt',target_expires_at),
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
    'amount',sale.total_minor,'qrString',session->>'qrString','qrImageUrl',session->>'qrImageUrl','paymentUrl',session->>'paymentUrl','expiresAt',session->>'expiresAt',
    'providerStatus',payment.provider_status,
    'payload',jsonb_build_object(
      'customerName',customer_name,
      'lines',coalesce((select jsonb_agg(jsonb_build_object('productId',i.product_id,'quantity',i.quantity,'discountMinor',i.discount_minor) order by i.id)
        from public.sale_items i where i.tenant_id=sale.tenant_id and i.sale_id=sale.id),'[]'::jsonb)
    )
  );
end $$;

revoke all on function public.attach_qris_payment_session_v2(uuid,text,text,text,text,timestamptz,jsonb) from public,anon;
grant execute on function public.attach_qris_payment_session_v2(uuid,text,text,text,text,timestamptz,jsonb) to authenticated;

commit;
