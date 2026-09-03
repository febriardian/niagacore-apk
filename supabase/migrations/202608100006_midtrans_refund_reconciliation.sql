begin;

alter table public.refunds add column if not exists provider text;
alter table public.refunds add column if not exists provider_reference text;
alter table public.refunds add column if not exists provider_payload jsonb not null default '{}'::jsonb;
create unique index if not exists refunds_provider_reference_unique
  on public.refunds(provider, provider_reference) where provider_reference is not null;

create or replace function public.request_midtrans_refund(
  target_sale_id uuid, refund_id uuid, refund_amount bigint, refund_reason text,
  stock_disposition text default 'restock'
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid := (select auth.uid()); sale public.sales%rowtype; member public.memberships%rowtype;
  refunded bigint; payment public.payments%rowtype;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  select * into sale from public.sales where id=target_sale_id for update;
  if sale.id is null or sale.payment_method <> 'qris' or sale.status not in ('paid','refunded') then raise exception 'qris_sale_not_refundable'; end if;
  select * into member from public.memberships where tenant_id=sale.tenant_id and user_id=actor and active limit 1;
  if member.id is null or member.role not in ('owner','supervisor') then raise exception 'approval_required'; end if;
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then raise exception 'mfa_required'; end if;
  if refund_amount <= 0 or char_length(trim(refund_reason)) < 4 or stock_disposition not in ('restock','damaged') then raise exception 'invalid_refund'; end if;
  select coalesce(sum(amount_minor),0) into refunded from public.refunds where sale_id=sale.id and status in ('pending','posted');
  if refunded + refund_amount > sale.total_minor then raise exception 'invalid_refund_amount'; end if;
  select * into payment from public.payments where sale_id=sale.id and provider='midtrans' limit 1;
  if payment.id is null then raise exception 'midtrans_payment_not_found'; end if;
  insert into public.refunds(id,tenant_id,business_id,branch_id,sale_id,amount_minor,reason,stock_disposition,status,
    requested_by,approved_by,occurred_at,provider,provider_reference)
  values(refund_id,sale.tenant_id,sale.business_id,sale.branch_id,sale.id,refund_amount,trim(refund_reason),stock_disposition,
    'pending',actor,actor,now(),'midtrans',refund_id::text);
  return jsonb_build_object('refundId',refund_id,'orderId',payment.provider_reference,'amount',refund_amount,'reason',trim(refund_reason));
end; $$;

create or replace function public.finalize_midtrans_refund(
  refund_reference text, provider_status text, provider_payload jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare refund public.refunds%rowtype; sale public.sales%rowtype; line record; entry_id uuid; returned_cost bigint:=0; posted_total bigint;
begin
  select * into refund from public.refunds where provider='midtrans' and provider_reference=refund_reference for update;
  if refund.id is null then raise exception 'refund_not_found'; end if;
  if refund.status='posted' then return jsonb_build_object('status','duplicate','refundId',refund.id); end if;
  if provider_status not in ('refund','partial_refund','success') then
    update public.refunds set provider_payload=provider_payload where id=refund.id;
    return jsonb_build_object('status','pending','refundId',refund.id);
  end if;
  select * into sale from public.sales where id=refund.sale_id and tenant_id=refund.tenant_id for update;
  update public.refunds set status='posted',provider_payload=provider_payload where id=refund.id;
  select coalesce(sum(amount_minor),0) into posted_total from public.refunds where sale_id=sale.id and status='posted';
  if posted_total >= sale.total_minor then update public.sales set status='refunded',updated_at=now(),version=version+1 where id=sale.id; end if;
  insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
  values(refund.tenant_id,refund.business_id,'refund',refund.id,'Retur QRIS','posted',now(),refund.approved_by) returning id into entry_id;
  insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
    (refund.tenant_id,entry_id,'4201',refund.amount_minor,0,'Retur penjualan'),
    (refund.tenant_id,entry_id,'1102',0,refund.amount_minor,'Refund dana dalam penyelesaian');
  if refund.stock_disposition='restock' then
    for line in select product_id,quantity,cost_minor from public.sale_items where tenant_id=sale.tenant_id and sale_id=sale.id loop
      insert into public.inventory_movements(tenant_id,branch_id,product_id,movement_type,quantity,unit_cost_minor,reference_type,reference_id,occurred_at)
      values(refund.tenant_id,refund.branch_id,line.product_id,'return_in',line.quantity*(refund.amount_minor::numeric/sale.total_minor),line.cost_minor,'refund',refund.id,now());
      returned_cost:=returned_cost+round(line.quantity*(refund.amount_minor::numeric/sale.total_minor)*line.cost_minor);
    end loop;
    if returned_cost>0 then insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
      (refund.tenant_id,entry_id,'1301',returned_cost,0,'Persediaan kembali'),
      (refund.tenant_id,entry_id,'5101',0,returned_cost,'Pembalikan HPP'); end if;
  end if;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(refund.tenant_id,refund.approved_by,'payment.qris.refund','refund',refund.id::text,'success',jsonb_build_object('providerStatus',provider_status));
  return jsonb_build_object('status','posted','refundId',refund.id,'saleId',sale.id);
end; $$;

revoke all on function public.request_midtrans_refund(uuid,uuid,bigint,text,text) from public;
grant execute on function public.request_midtrans_refund(uuid,uuid,bigint,text,text) to authenticated;
revoke all on function public.finalize_midtrans_refund(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_midtrans_refund(text,text,jsonb) to service_role;

commit;
