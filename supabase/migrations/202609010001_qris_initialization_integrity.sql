begin;

-- Perbaiki trigger lama yang membandingkan enum sale_status dengan string kosong.
-- Ekspresi coalesce(old.status,'') membuat PostgreSQL mencoba mengubah '' menjadi
-- sale_status setiap kali status penjualan diperbarui.
create or replace function private.on_qris_sale_paid()
returns trigger language plpgsql security definer set search_path='' as $$
declare policy public.wallet_policies%rowtype; fee bigint; reserve_amount bigint;
begin
  if new.payment_method<>'qris' or new.status<>'paid' or old.status='paid' then return new; end if;
  insert into public.wallet_policies(tenant_id) values(new.tenant_id) on conflict(tenant_id) do nothing;
  select * into policy from public.wallet_policies where tenant_id=new.tenant_id;
  fee:=round(new.total_minor*policy.platform_fee_bps::numeric/10000);
  reserve_amount:=round(new.total_minor*policy.reserve_bps::numeric/10000);
  perform private.wallet_post(new.tenant_id,'payment_gross','sale',new.id,'payment_gross:'||new.id,new.total_minor,0,0,0,jsonb_build_object('receiptNumber',new.receipt_number));
  if fee>0 then perform private.wallet_post(new.tenant_id,'platform_fee','sale',new.id,'platform_fee:'||new.id,-fee,0,0,0,jsonb_build_object('basisPoints',policy.platform_fee_bps)); end if;
  if reserve_amount>0 then perform private.wallet_post(new.tenant_id,'reserve_hold','sale',new.id,'reserve_hold:'||new.id,-reserve_amount,0,reserve_amount,0,jsonb_build_object('releaseAfter',now()+make_interval(days=>policy.reserve_days))); end if;
  insert into public.receipt_verifications(sale_id,tenant_id,receipt_number,total_minor,payment_method,occurred_at)
  values(new.id,new.tenant_id,new.receipt_number,new.total_minor,new.payment_method,new.occurred_at)
  on conflict(sale_id) do nothing;
  return new;
end; $$;

create or replace function public.fail_qris_payment_initialization(
  target_sale_id uuid,
  error_code text,
  provider_status text,
  diagnostics jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); sale public.sales%rowtype;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  select * into sale from public.sales
  where id=target_sale_id and cashier_id=actor and status='pending_payment'
  for update;
  if sale.id is null or not private.can_access_branch(sale.tenant_id,sale.branch_id) then
    raise exception 'pending_sale_not_found';
  end if;
  update public.payments set
    provider_status='initialization_failed',
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
      'qrisInitializationFailure',jsonb_build_object(
        'errorCode',left(coalesce(error_code,'unknown'),100),
        'providerStatus',left(coalesce(provider_status,'unknown'),100),
        'diagnostics',coalesce(diagnostics,'{}'::jsonb),
        'failedAt',now()
      )
    )
  where tenant_id=sale.tenant_id and sale_id=sale.id and method='qris';
  update public.sales set status='void',version=version+1,updated_at=now() where id=sale.id;
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result,metadata)
  values(sale.tenant_id,actor,sale.device_id,'payment.qris.initialization_failed','sale',sale.id::text,'failed',
    jsonb_build_object('errorCode',left(coalesce(error_code,'unknown'),100)));
end $$;

revoke all on function public.fail_qris_payment_initialization(uuid,text,text,jsonb) from public,anon;
grant execute on function public.fail_qris_payment_initialization(uuid,text,text,jsonb) to authenticated;

update public.payments p set
  provider_status='initialization_failed',
  metadata=coalesce(p.metadata,'{}'::jsonb)||jsonb_build_object('qrisInitializationFailure',jsonb_build_object('errorCode','legacy_missing_qr_session','failedAt',now()))
from public.sales s
where p.tenant_id=s.tenant_id and p.sale_id=s.id and p.method='qris'
  and s.status='pending_payment' and s.created_at<now()-interval '30 minutes'
  and not (p.metadata?'qrisSession');

update public.sales s set status='void',version=version+1,updated_at=now()
where s.status='pending_payment' and s.payment_method='qris' and s.created_at<now()-interval '30 minutes'
  and exists(select 1 from public.payments p where p.tenant_id=s.tenant_id and p.sale_id=s.id and p.method='qris' and not (p.metadata?'qrisSession'));

commit;
