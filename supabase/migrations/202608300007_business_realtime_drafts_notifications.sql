begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table public.sale_drafts (
  id uuid primary key,
  tenant_id uuid not null,
  business_id uuid not null,
  branch_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  customer_id uuid,
  lines jsonb not null default '[]'::jsonb check(jsonb_typeof(lines)='array'),
  updated_at timestamptz not null default now(),
  foreign key(tenant_id,business_id) references public.businesses(tenant_id,id) on delete cascade,
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id) on delete cascade,
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete set null,
  unique(tenant_id,business_id,branch_id,user_id)
);

alter table public.sale_drafts enable row level security;
create policy sale_drafts_read on public.sale_drafts for select to authenticated
using(user_id=(select auth.uid()) and private.can_access_branch(tenant_id,branch_id));
create policy sale_drafts_insert on public.sale_drafts for insert to authenticated
with check(user_id=(select auth.uid()) and private.can_access_branch(tenant_id,branch_id));
create policy sale_drafts_update on public.sale_drafts for update to authenticated
using(user_id=(select auth.uid()) and private.can_access_branch(tenant_id,branch_id))
with check(user_id=(select auth.uid()) and private.can_access_branch(tenant_id,branch_id));
create policy sale_drafts_delete on public.sale_drafts for delete to authenticated
using(user_id=(select auth.uid()) and private.can_access_branch(tenant_id,branch_id));

create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  token text not null,
  platform text not null default 'android',
  enabled boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key(tenant_id,device_id) references public.devices(tenant_id,id) on delete cascade,
  unique(token),
  unique(tenant_id,user_id,device_id)
);

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check(category in('receivable_due','low_stock','lot_expiry','payment_received','shift_open')),
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  status text not null default 'pending' check(status in('pending','processing','sent','failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique(recipient_user_id,dedupe_key)
);

alter table public.push_tokens enable row level security;
alter table public.notification_outbox enable row level security;
create policy push_tokens_own_read on public.push_tokens for select to authenticated using(user_id=(select auth.uid()));
create policy push_tokens_own_delete on public.push_tokens for delete to authenticated using(user_id=(select auth.uid()));
create policy notification_outbox_own_read on public.notification_outbox for select to authenticated using(recipient_user_id=(select auth.uid()));

create or replace function public.register_push_token(target_device_id uuid,target_token text,target_platform text default 'android')
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); member public.memberships%rowtype; result uuid;
begin
  if actor is null or nullif(trim(target_token),'') is null then raise exception 'invalid_push_registration'; end if;
  select m.* into member from public.memberships m join public.devices d on d.tenant_id=m.tenant_id
   where m.user_id=actor and m.active and d.id=target_device_id and d.status='active' limit 1;
  if member.id is null then raise exception 'device_access_denied'; end if;
  delete from public.push_tokens where token=trim(target_token)
    and (tenant_id<>member.tenant_id or user_id<>actor or device_id<>target_device_id);
  insert into public.push_tokens(tenant_id,user_id,device_id,token,platform,enabled,last_seen_at)
  values(member.tenant_id,actor,target_device_id,trim(target_token),coalesce(nullif(trim(target_platform),''),'android'),true,now())
  on conflict(tenant_id,user_id,device_id) do update set token=excluded.token,platform=excluded.platform,enabled=true,last_seen_at=now()
  returning id into result;
  return result;
end $$;
revoke all on function public.register_push_token(uuid,text,text) from public,anon;
grant execute on function public.register_push_token(uuid,text,text) to authenticated;

create or replace function public.create_business_workspace(target_name text,enabled_modules text[],branch_name text,branch_code text)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); member public.memberships%rowtype; business_id uuid; normalized_code text:=upper(trim(branch_code));
begin
  select * into member from public.memberships where user_id=actor and active and role in('owner','business_manager') order by created_at limit 1;
  if member.id is null then raise exception 'permission_denied'; end if;
  if char_length(trim(target_name)) not between 2 and 160 or char_length(trim(branch_name)) not between 2 and 160
    or normalized_code!~'^[A-Z0-9_-]{2,20}$' then raise exception 'invalid_business_workspace'; end if;
  if enabled_modules is null or cardinality(enabled_modules)=0 or not(enabled_modules<@array['retail','food_service','services','wholesale']::text[]) then raise exception 'invalid_business_modules'; end if;
  if exists(select 1 from public.businesses where tenant_id=member.tenant_id and lower(name)=lower(trim(target_name))) then raise exception 'business_name_exists'; end if;
  insert into public.businesses(tenant_id,name,modules) values(member.tenant_id,trim(target_name),enabled_modules) returning id into business_id;
  insert into public.branches(tenant_id,business_id,name,code) values(member.tenant_id,business_id,trim(branch_name),normalized_code);
  return business_id;
end $$;

create or replace function public.update_business_workspace(target_business_id uuid,target_name text,enabled_modules text[])
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); target public.businesses%rowtype;
begin
  select b.* into target from public.businesses b join public.memberships m on m.tenant_id=b.tenant_id
   where b.id=target_business_id and m.user_id=actor and m.active and m.role in('owner','business_manager') limit 1;
  if target.id is null then raise exception 'permission_denied'; end if;
  if char_length(trim(target_name)) not between 2 and 160 or enabled_modules is null or cardinality(enabled_modules)=0
    or not(enabled_modules<@array['retail','food_service','services','wholesale']::text[]) then raise exception 'invalid_business_workspace'; end if;
  if exists(select 1 from public.businesses where tenant_id=target.tenant_id and id<>target.id and lower(name)=lower(trim(target_name))) then raise exception 'business_name_exists'; end if;
  update public.businesses set name=trim(target_name),modules=enabled_modules,updated_at=now() where id=target.id;
end $$;
revoke all on function public.create_business_workspace(text,text[],text,text) from public,anon;
revoke all on function public.update_business_workspace(uuid,text,text[]) from public,anon;
grant execute on function public.create_business_workspace(text,text[],text,text) to authenticated;
grant execute on function public.update_business_workspace(uuid,text,text[]) to authenticated;

create or replace function public.enqueue_operational_notifications()
returns integer language plpgsql security definer set search_path='' as $$
declare inserted_count integer;
begin
  with product_stock as (
    select b.tenant_id,b.id branch_id,b.business_id,p.id product_id,p.name,p.unit,
      case when coalesce(p.metadata->>'minimumStock','')~'^[0-9]+([.][0-9]+)?$' then (p.metadata->>'minimumStock')::numeric else 0 end minimum_stock,
      coalesce(sum(im.quantity),0) quantity
    from public.branches b join public.products p on p.tenant_id=b.tenant_id and p.business_id=b.business_id and p.active and p.track_stock
    left join public.inventory_movements im on im.tenant_id=b.tenant_id and im.branch_id=b.id and im.product_id=p.id
    where b.active group by b.tenant_id,b.id,b.business_id,p.id,p.name,p.unit,p.metadata
  ), low_stock as (
    select b.tenant_id,b.branch_id,'low_stock'::text category,'Stok menipis'::text title,
      b.name||' tersisa '||b.quantity::text||' '||b.unit body,
      jsonb_build_object('productId',b.product_id,'businessId',b.business_id,'branchId',b.branch_id) data,
      'low_stock:'||b.branch_id::text||':'||b.product_id::text||':'||current_date::text dedupe_key
    from product_stock b where b.minimum_stock>0 and b.quantity<=b.minimum_stock
  ), due_receivables as (
    select d.tenant_id,d.branch_id,'receivable_due','Piutang jatuh tempo',
      coalesce(r.title,'Tagihan pelanggan')||' memiliki sisa Rp '||trim(to_char(d.original_minor-d.settled_minor,'FM999G999G999G990')),
      jsonb_build_object('documentId',d.id,'businessId',d.business_id,'branchId',d.branch_id),
      'receivable_due:'||d.id::text||':'||current_date::text
    from public.subledger_documents d left join public.business_records r on r.id=d.id
    where d.document_type='receivable' and d.original_minor>d.settled_minor and d.due_at<=current_date and d.status<>'paid'
  ), expiring_lots as (
    select l.tenant_id,l.branch_id,'lot_expiry','Batch mendekati kedaluwarsa',
      p.name||' batch '||l.lot_code||' kedaluwarsa '||to_char(l.expires_at,'DD Mon YYYY'),
      jsonb_build_object('lotId',l.id,'businessId',l.business_id,'branchId',l.branch_id),
      'lot_expiry:'||l.id::text||':'||current_date::text
    from public.inventory_lots l join public.products p on p.id=l.product_id
    where l.status='available' and l.quantity>0 and l.expires_at between current_date and current_date+7
  ), received_payments as (
    select s.tenant_id,s.branch_id,'payment_received','Pembayaran diterima',
      s.receipt_number||' menerima Rp '||trim(to_char(p.amount_minor,'FM999G999G999G990')),
      jsonb_build_object('paymentId',p.id,'saleId',s.id,'businessId',s.business_id,'branchId',s.branch_id),
      'payment_received:'||p.id::text
    from public.payments p join public.sales s on s.tenant_id=p.tenant_id and s.id=p.sale_id
    where p.paid_at>=now()-interval '20 minutes'
  ), open_shifts as (
    select s.tenant_id,s.branch_id,'shift_open','Shift belum ditutup',
      'Shift yang dibuka '||to_char(s.opened_at at time zone 'Asia/Jakarta','DD Mon HH24:MI')||' masih aktif',
      jsonb_build_object('shiftId',s.id,'userId',s.user_id,'branchId',s.branch_id),
      'shift_open:'||s.id::text||':'||current_date::text
    from public.shifts s where s.status='open' and s.opened_at<now()-interval '12 hours'
  ), candidates as (
    select * from low_stock union all select * from due_receivables union all select * from expiring_lots
    union all select * from received_payments union all select * from open_shifts
  )
  insert into public.notification_outbox(tenant_id,branch_id,recipient_user_id,category,title,body,data,dedupe_key)
  select c.tenant_id,c.branch_id,m.user_id,c.category,c.title,c.body,c.data,c.dedupe_key
  from candidates c join public.memberships m on m.tenant_id=c.tenant_id and m.active
  where (m.role in('owner','business_manager') or exists(select 1 from public.membership_branches mb where mb.membership_id=m.id and mb.branch_id=c.branch_id))
    and case c.category
      when 'low_stock' then m.role in('owner','business_manager','branch_manager','supervisor','warehouse','purchasing')
      when 'receivable_due' then m.role in('owner','business_manager','branch_manager','supervisor','finance')
      when 'lot_expiry' then m.role in('owner','business_manager','branch_manager','supervisor','warehouse','purchasing')
      when 'payment_received' then m.role in('owner','business_manager','branch_manager','supervisor','finance','cashier')
      when 'shift_open' then m.role in('owner','business_manager','branch_manager','supervisor') or m.user_id=(c.data->>'userId')::uuid
      else false end
  on conflict(recipient_user_id,dedupe_key) do nothing;
  get diagnostics inserted_count=row_count;
  return inserted_count;
end $$;
revoke all on function public.enqueue_operational_notifications() from public,anon,authenticated;

create table private.notification_delivery_settings(
  singleton boolean primary key default true check(singleton),
  edge_base_url text not null,
  anon_key text not null,
  cron_secret text not null,
  updated_at timestamptz not null default now()
);
revoke all on private.notification_delivery_settings from public,anon,authenticated;

create or replace function public.configure_notification_delivery(edge_base_url text,anon_key text,cron_secret text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if (select auth.role())<>'service_role' and current_user not in('postgres','supabase_admin') then raise exception 'service_role_required'; end if;
  if edge_base_url!~'^https://[a-z0-9-]+\.supabase\.co$' or length(anon_key)<20 or length(cron_secret)<24 then raise exception 'invalid_notification_delivery_settings'; end if;
  insert into private.notification_delivery_settings(singleton,edge_base_url,anon_key,cron_secret)
  values(true,rtrim(edge_base_url,'/'),anon_key,cron_secret)
  on conflict(singleton) do update set edge_base_url=excluded.edge_base_url,anon_key=excluded.anon_key,cron_secret=excluded.cron_secret,updated_at=now();
end $$;
revoke all on function public.configure_notification_delivery(text,text,text) from public,anon,authenticated;
grant execute on function public.configure_notification_delivery(text,text,text) to service_role;

create or replace function private.run_notification_cycle()
returns void language plpgsql security definer set search_path='' as $$
declare settings private.notification_delivery_settings%rowtype;
begin
  perform public.enqueue_operational_notifications();
  select * into settings from private.notification_delivery_settings where singleton;
  if settings.singleton then
    perform net.http_post(
      url:=settings.edge_base_url||'/functions/v1/notification-dispatch',
      headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||settings.anon_key,'x-cron-secret',settings.cron_secret),
      body:='{}'::jsonb,
      timeout_milliseconds:=10000
    );
  end if;
end $$;

do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname='niagacore-operational-notifications';
  perform cron.schedule('niagacore-operational-notifications','*/15 * * * *','select private.run_notification_cycle()');
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array['sales','payments','inventory_movements','subledger_documents','shifts','sale_drafts','notification_outbox'] loop
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=table_name) then
      execute format('alter publication supabase_realtime add table public.%I',table_name);
    end if;
    execute format('alter table public.%I replica identity full',table_name);
  end loop;
end $$;

commit;
