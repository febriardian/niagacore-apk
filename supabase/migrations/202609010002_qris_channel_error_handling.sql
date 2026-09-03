begin;

create or replace function public.fail_qris_payment_initialization_server(
  target_sale_id uuid,
  error_code text,
  target_provider_status text,
  target_diagnostics jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare sale public.sales%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required'; end if;
  select * into sale from public.sales where id=target_sale_id and status='pending_payment' for update;
  if sale.id is null then raise exception 'pending_sale_not_found'; end if;
  update public.payments set
    provider_status='initialization_failed',
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
      'qrisInitializationFailure',jsonb_build_object(
        'errorCode',left(coalesce(error_code,'unknown'),100),
        'providerStatus',left(coalesce(target_provider_status,'unknown'),100),
        'diagnostics',coalesce(target_diagnostics,'{}'::jsonb),
        'failedAt',now()
      )
    )
  where tenant_id=sale.tenant_id and sale_id=sale.id and method='qris';
  update public.sales set status='void',version=version+1,updated_at=now() where id=sale.id;
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result,metadata)
  values(sale.tenant_id,sale.cashier_id,sale.device_id,'payment.qris.initialization_failed','sale',sale.id::text,'failed',
    jsonb_build_object('errorCode',left(coalesce(error_code,'unknown'),100),'providerStatus',left(coalesce(target_provider_status,'unknown'),100)));
end $$;

revoke all on function public.fail_qris_payment_initialization_server(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.fail_qris_payment_initialization_server(uuid,text,text,jsonb) to service_role;

update public.payments p set
  provider_status='initialization_failed',
  metadata=coalesce(p.metadata,'{}'::jsonb)||jsonb_build_object('qrisInitializationFailure',jsonb_build_object('errorCode','orphaned_initialization','failedAt',now()))
from public.sales s
where p.tenant_id=s.tenant_id and p.sale_id=s.id and p.method='qris'
  and s.status='pending_payment' and s.created_at<now()-interval '5 minutes'
  and not (p.metadata?'qrisSession');

update public.sales s set status='void',version=version+1,updated_at=now()
where s.status='pending_payment' and s.payment_method='qris' and s.created_at<now()-interval '5 minutes'
  and exists(select 1 from public.payments p where p.tenant_id=s.tenant_id and p.sale_id=s.id and p.method='qris' and not (p.metadata?'qrisSession'));

commit;
