begin;

-- The first staff implementation only admitted cashier/supervisor.  Remove
-- that legacy guard before the expanded blueprint roles are used.
alter table public.staff_invitations drop constraint if exists staff_invitations_role_check;
alter table public.staff_invitations drop constraint if exists staff_invitations_role_not_owner;
alter table public.staff_invitations add constraint staff_invitations_role_not_owner check(role<>'owner');

alter type public.membership_role add value if not exists 'business_manager';
alter type public.membership_role add value if not exists 'branch_manager';
alter type public.membership_role add value if not exists 'warehouse';
alter type public.membership_role add value if not exists 'purchasing';
alter type public.membership_role add value if not exists 'finance';
alter type public.membership_role add value if not exists 'service_staff';
alter type public.membership_role add value if not exists 'kitchen';
alter type public.membership_role add value if not exists 'waiter';
alter type public.membership_role add value if not exists 'auditor';

-- PostgreSQL requires newly-added enum values to be committed before they are
-- used by rows, policies, or function bodies in the same migration.
commit;
begin;

create table if not exists public.role_permissions(
  role public.membership_role not null,
  permission text not null check(permission ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.(own|branch|business|tenant)$'),
  primary key(role,permission)
);
alter table public.role_permissions enable row level security;
drop policy if exists role_permissions_read on public.role_permissions;
create policy role_permissions_read on public.role_permissions for select to authenticated using(true);

insert into public.role_permissions(role,permission) values
  ('owner','members.manage.tenant'),('owner','settings.manage.business'),('owner','approvals.manage.business'),('owner','reports.read.business'),
  ('business_manager','members.manage.tenant'),('business_manager','approvals.manage.business'),('business_manager','reports.read.business'),
  ('branch_manager','approvals.manage.branch'),('branch_manager','reports.read.branch'),
  ('supervisor','approvals.manage.branch'),('supervisor','reports.read.branch'),
  ('finance','accounting.manage.business'),('finance','reports.read.business'),
  ('auditor','accounting.read.business'),('auditor','reports.read.business'),
  ('warehouse','inventory.manage.branch'),('purchasing','purchases.manage.business'),
  ('cashier','sales.create.branch'),('waiter','sales.create.branch')
on conflict do nothing;

create or replace function private.current_role(target_tenant uuid)
returns public.membership_role language sql stable security definer set search_path='' as $$
  select m.role from public.memberships m
  where m.tenant_id=target_tenant and m.user_id=(select auth.uid()) and m.active
  order by m.created_at limit 1
$$;

create or replace function private.has_permission(target_tenant uuid,target_permission text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.memberships m join public.role_permissions rp on rp.role=m.role
    where m.tenant_id=target_tenant and m.user_id=(select auth.uid()) and m.active and rp.permission=target_permission
  )
$$;

create or replace function private.can_access_branch(target_tenant uuid,target_branch uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.memberships m
    where m.tenant_id=target_tenant and m.user_id=(select auth.uid()) and m.active
      and (m.role in ('owner','business_manager') or exists(
        select 1 from public.membership_branches mb
        where mb.tenant_id=m.tenant_id and mb.membership_id=m.id and mb.branch_id=target_branch
      ))
  )
$$;

revoke all on function private.current_role(uuid) from public;
revoke all on function private.has_permission(uuid,text) from public;
revoke all on function private.can_access_branch(uuid,uuid) from public;
grant execute on function private.current_role(uuid),private.has_permission(uuid,text),private.can_access_branch(uuid,uuid) to authenticated;

drop policy if exists branches_select_member on public.branches;
create policy branches_select_granted on public.branches for select to authenticated
  using(private.can_access_branch(tenant_id,id));
drop policy if exists membership_branches_select_member on public.membership_branches;
create policy membership_branches_select_scoped on public.membership_branches for select to authenticated using(
  exists(select 1 from public.memberships self where self.id=membership_id and self.user_id=(select auth.uid()) and self.active)
  or private.has_permission(tenant_id,'members.manage.tenant')
);
drop policy if exists staff_invitations_owner_read on public.staff_invitations;
create policy staff_invitations_manager_read on public.staff_invitations for select to authenticated using(
  private.has_permission(tenant_id,'members.manage.tenant')
);
drop policy if exists devices_select_member on public.devices;
create policy devices_select_scoped on public.devices for select to authenticated using(
  private.can_access_branch(tenant_id,branch_id) and (
    private.has_permission(tenant_id,'members.manage.tenant') or id in(
      select distinct ae.device_id from public.audit_events ae where ae.tenant_id=devices.tenant_id and ae.actor_id=(select auth.uid()) and ae.device_id is not null
    )
  )
);
drop policy if exists sync_mutations_select_member on public.sync_mutations;
create policy sync_mutations_select_scoped on public.sync_mutations for select to authenticated
  using(private.can_access_branch(tenant_id,branch_id));

do $$ declare t text; begin
  foreach t in array array['sales','inventory_movements','purchases','expenses','appointments','dining_tables','business_records','shifts','cash_movements','refunds','approval_requests'] loop
    execute format('drop policy if exists %I on public.%I',t||'_select_member',t);
    execute format('create policy %I on public.%I for select to authenticated using(private.can_access_branch(tenant_id,branch_id))',t||'_select_branch',t);
  end loop;
end $$;

drop policy if exists sale_items_select_member on public.sale_items;
create policy sale_items_select_branch on public.sale_items for select to authenticated using(exists(
  select 1 from public.sales s where s.tenant_id=sale_items.tenant_id and s.id=sale_items.sale_id and private.can_access_branch(s.tenant_id,s.branch_id)
));
drop policy if exists payments_select_member on public.payments;
create policy payments_select_branch on public.payments for select to authenticated using(exists(
  select 1 from public.sales s where s.tenant_id=payments.tenant_id and s.id=payments.sale_id and private.can_access_branch(s.tenant_id,s.branch_id)
));

drop policy if exists accounts_select_member on public.accounts;
drop policy if exists journal_entries_select_member on public.journal_entries;
drop policy if exists journal_lines_select_member on public.journal_lines;
create policy accounts_select_finance on public.accounts for select to authenticated using(
  private.current_role(tenant_id) in ('owner','business_manager','branch_manager','supervisor','finance','auditor')
);
create policy journal_entries_select_finance on public.journal_entries for select to authenticated using(
  private.current_role(tenant_id) in ('owner','business_manager','branch_manager','supervisor','finance','auditor')
);
create policy journal_lines_select_finance on public.journal_lines for select to authenticated using(
  private.current_role(tenant_id) in ('owner','business_manager','branch_manager','supervisor','finance','auditor')
);

create or replace function private.enforce_sync_scope()
returns trigger language plpgsql security definer set search_path='' as $$
declare actor_role public.membership_role;
begin
  if not private.can_access_branch(new.tenant_id,new.branch_id) then raise exception 'branch_access_denied'; end if;
  actor_role:=private.current_role(new.tenant_id);
  if actor_role is null then raise exception 'tenant_access_denied'; end if;
  if new.aggregate_type in ('product','price_list','product_bundle') and actor_role not in ('owner','business_manager','branch_manager','supervisor') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('manual_journal','fiscal_period','tax','asset','accounting_settings') and actor_role not in ('owner','finance') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('purchase_order','goods_receipt','supplier_bill','purchase_return','payable') and actor_role not in ('owner','business_manager','branch_manager','supervisor','purchasing','warehouse','finance') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('stock_count','stock_transfer','stock_adjustment','lot') and actor_role not in ('owner','business_manager','branch_manager','supervisor','warehouse') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('sale','shift','cash_movement') and actor_role not in ('owner','business_manager','branch_manager','supervisor','cashier','waiter') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('customer','customer_segment','loyalty') and actor_role not in ('owner','business_manager','branch_manager','supervisor','cashier','service_staff','waiter') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('appointment','service_order') and actor_role not in ('owner','business_manager','branch_manager','supervisor','service_staff') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('dining_table','kitchen_ticket','recipe') and actor_role not in ('owner','business_manager','branch_manager','supervisor','kitchen','waiter') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('expense','receivable','payable') and actor_role not in ('owner','business_manager','branch_manager','supervisor','finance') then raise exception 'permission_denied'; end if;
  if new.aggregate_type in ('supplier','purchase_order','goods_receipt','supplier_bill','purchase_return') and actor_role not in ('owner','business_manager','branch_manager','supervisor','purchasing','warehouse','finance') then raise exception 'permission_denied'; end if;
  if actor_role='auditor' then raise exception 'permission_denied'; end if;
  return new;
end $$;
drop trigger if exists sync_mutations_enforce_scope on public.sync_mutations;
create trigger sync_mutations_enforce_scope before insert on public.sync_mutations for each row execute function private.enforce_sync_scope();

-- Existing installations already own the v1 sync functions.  Their original
-- role guards predate the expanded role matrix.  Loosen those coarse guards;
-- the trigger above remains the authoritative, aggregate-specific check.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.apply_sync_batch(uuid,jsonb)'::regprocedure);
  definition:=replace(definition,
    'membership.role not in (''owner'',''supervisor'')',
    'membership.role not in (''owner'',''business_manager'',''branch_manager'',''supervisor'',''warehouse'',''purchasing'',''finance'')');
  execute definition;

  definition:=pg_get_functiondef('public.apply_extended_sync_batch(uuid,jsonb)'::regprocedure);
  definition:=replace(definition,
    'membership.role not in (''owner'',''supervisor'')',
    'membership.role not in (''owner'',''business_manager'',''branch_manager'',''supervisor'',''warehouse'',''purchasing'',''finance'')');
  definition:=replace(definition,
    'membership.role=''cashier''',
    'membership.role in (''cashier'',''waiter'',''service_staff'',''kitchen'',''auditor'')');
  definition:=replace(definition,
    'membership.role<>''owner''',
    'membership.role not in (''owner'',''business_manager'',''finance'')');
  execute definition;
end $$;

drop function if exists public.list_staff_access();
create function public.list_staff_access()
returns table(id uuid,email text,display_name text,role public.membership_role,active boolean,branch_names text[],branch_ids uuid[],last_seen_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());target_tenant uuid;
begin
  select m.tenant_id into target_tenant from public.memberships m where m.user_id=actor and m.active and m.role in ('owner','business_manager') order by m.created_at limit 1;
  if target_tenant is null then raise exception 'owner_required'; end if;
  return query select m.id,coalesce(u.email::text,''),p.display_name::text,m.role,m.active,
    coalesce(array_agg(distinct b.name::text) filter(where b.id is not null),array[]::text[]),
    coalesce(array_agg(distinct b.id) filter(where b.id is not null),array[]::uuid[]),
    (select max(d.last_seen_at) from public.devices d join public.audit_events ae on ae.device_id=d.id and ae.tenant_id=d.tenant_id where d.tenant_id=m.tenant_id and ae.actor_id=m.user_id)
  from public.memberships m join auth.users u on u.id=m.user_id left join public.profiles p on p.id=m.user_id
  left join public.membership_branches mb on mb.tenant_id=m.tenant_id and mb.membership_id=m.id
  left join public.branches b on b.id=mb.branch_id and b.tenant_id=m.tenant_id
  where m.tenant_id=target_tenant group by m.id,u.email,p.display_name,m.role,m.active,m.created_at order by case when m.role='owner' then 0 else 1 end,m.created_at;
end $$;

create or replace function public.update_staff_access(target_membership_id uuid,target_role public.membership_role,target_branch_ids uuid[],target_active boolean)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());manager public.memberships%rowtype;target public.memberships%rowtype;
begin
  select * into target from public.memberships where id=target_membership_id for update;
  select * into manager from public.memberships where tenant_id=target.tenant_id and user_id=actor and active and role in ('owner','business_manager') limit 1;
  if manager.id is null or target.id is null or target.role='owner' or target_role='owner' then raise exception 'invalid_staff_target'; end if;
  if manager.role='business_manager' and target_role='business_manager' then raise exception 'owner_required'; end if;
  if cardinality(target_branch_ids)=0 or exists(select 1 from unnest(target_branch_ids) branch_id where not exists(select 1 from public.branches b where b.tenant_id=target.tenant_id and b.id=branch_id and b.active)) then raise exception 'invalid_branch_access'; end if;
  update public.memberships set role=target_role,active=target_active,updated_at=now() where id=target.id;
  delete from public.membership_branches where tenant_id=target.tenant_id and membership_id=target.id;
  insert into public.membership_branches(tenant_id,membership_id,branch_id) select target.tenant_id,target.id,branch_id from unnest(target_branch_ids) branch_id;
  if not target_active then update public.devices set status='revoked',updated_at=now() where tenant_id=target.tenant_id and id in(select ae.device_id from public.audit_events ae where ae.tenant_id=target.tenant_id and ae.actor_id=target.user_id and ae.device_id is not null); end if;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata) values(target.tenant_id,actor,'staff.update','membership',target.id::text,'success',jsonb_build_object('role',target_role,'active',target_active,'branches',target_branch_ids));
end $$;

create or replace function public.create_staff_invitation(target_email text,target_role public.membership_role,target_branch_ids uuid[])
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());member public.memberships%rowtype;invitation_id uuid:=gen_random_uuid();normalized text:=lower(trim(target_email));target_tenant uuid;
begin
  select b.tenant_id into target_tenant from public.branches b where b.id=target_branch_ids[1] and b.active;
  select * into member from public.memberships where tenant_id=target_tenant and user_id=actor and active and role in ('owner','business_manager') limit 1;
  if member.id is null then raise exception 'owner_required'; end if;
  if coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'mfa_required'; end if;
  if target_role='owner' or (member.role='business_manager' and target_role='business_manager') or normalized!~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid_invitation'; end if;
  if cardinality(target_branch_ids)=0 or exists(select 1 from unnest(target_branch_ids) branch_id where not exists(select 1 from public.branches br where br.id=branch_id and br.tenant_id=member.tenant_id and br.active)) then raise exception 'invalid_branch_access'; end if;
  update public.staff_invitations set status='expired',updated_at=now() where tenant_id=member.tenant_id and lower(email)=normalized and status='pending' and expires_at<=now();
  if exists(select 1 from public.staff_invitations where tenant_id=member.tenant_id and lower(email)=normalized and status='pending' and expires_at>now()) then raise exception 'pending_email'; end if;
  insert into public.staff_invitations(id,tenant_id,email,role,branch_ids,invited_by) values(invitation_id,member.tenant_id,normalized,target_role,target_branch_ids,actor);
  return invitation_id;
end $$;

create or replace function public.cancel_staff_invitation(target_invitation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());invitation public.staff_invitations%rowtype;
begin
  select * into invitation from public.staff_invitations where id=target_invitation_id for update;
  if invitation.id is null then raise exception 'invitation_not_found'; end if;
  if not private.has_permission(invitation.tenant_id,'members.manage.tenant') then raise exception 'owner_required'; end if;
  if invitation.status<>'pending' then raise exception 'invitation_not_pending'; end if;
  update public.staff_invitations set status='revoked',updated_at=now() where id=invitation.id;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result)
  values(invitation.tenant_id,actor,'staff.invitation.cancel','staff_invitation',invitation.id::text,'success');
end $$;

create or replace function public.resolve_approval_request(target_approval_id uuid,decision text,decision_note text default null)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());request public.approval_requests%rowtype;refund public.refunds%rowtype;member public.memberships%rowtype;
  sale public.sales%rowtype;sale_line record;refund_entry uuid;refunded_total bigint;returned_cost bigint:=0;
begin
  if decision not in ('approved','rejected') then raise exception 'invalid_decision'; end if;
  select * into request from public.approval_requests where id=target_approval_id and status='pending' for update;
  if request.id is not null then
    select * into member from public.memberships where tenant_id=request.tenant_id and user_id=actor and active limit 1;
    if member.role not in ('owner','business_manager','branch_manager','supervisor') or not private.can_access_branch(request.tenant_id,request.branch_id) then raise exception 'approval_access_denied'; end if;
    update public.approval_requests set status=decision,approver_id=actor,resolved_at=now(),payload=payload||jsonb_build_object('decisionNote',decision_note) where id=request.id;
  else
    select * into refund from public.refunds where id=target_approval_id and status='pending' for update;
    if refund.id is null then raise exception 'approval_not_found'; end if;
    select * into member from public.memberships where tenant_id=refund.tenant_id and user_id=actor and active limit 1;
    if member.role not in ('owner','business_manager','branch_manager','supervisor') or not private.can_access_branch(refund.tenant_id,refund.branch_id) then raise exception 'approval_access_denied'; end if;
    if decision='rejected' then
      update public.refunds set status='rejected',approved_by=actor where id=refund.id;
    else
      select * into sale from public.sales where id=refund.sale_id and tenant_id=refund.tenant_id for update;
      if sale.id is null then raise exception 'sale_not_found'; end if;
      if sale.payment_method='qris' then raise exception 'qris_refund_requires_provider'; end if;
      select coalesce(sum(r.amount_minor),0) into refunded_total from public.refunds r
        where r.tenant_id=refund.tenant_id and r.sale_id=refund.sale_id and r.status='posted' and r.id<>refund.id;
      if refunded_total+refund.amount_minor>sale.total_minor then raise exception 'invalid_refund_amount'; end if;
      update public.refunds set status='posted',approved_by=actor where id=refund.id;
      insert into public.journal_entries(tenant_id,business_id,source_type,source_id,memo,status,occurred_at,posted_by)
      values(refund.tenant_id,refund.business_id,'refund',refund.id,'Retur penjualan','posted',now(),actor)
      returning id into refund_entry;
      insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
        (refund.tenant_id,refund_entry,'4201',refund.amount_minor,0,'Retur penjualan'),
        (refund.tenant_id,refund_entry,'1101',0,refund.amount_minor,'Pengembalian kas');
      if refund.stock_disposition='restock' then
        for sale_line in select product_id,quantity,cost_minor from public.sale_items where tenant_id=refund.tenant_id and sale_id=refund.sale_id loop
          insert into public.inventory_movements(tenant_id,branch_id,product_id,movement_type,quantity,unit_cost_minor,reference_type,reference_id,occurred_at)
          values(refund.tenant_id,refund.branch_id,sale_line.product_id,'return_in',sale_line.quantity*(refund.amount_minor::numeric/sale.total_minor),sale_line.cost_minor,'refund',refund.id,now());
          returned_cost:=returned_cost+round(sale_line.quantity*(refund.amount_minor::numeric/sale.total_minor)*sale_line.cost_minor);
        end loop;
        if returned_cost>0 then insert into public.journal_lines(tenant_id,entry_id,account_code,debit_minor,credit_minor,description) values
          (refund.tenant_id,refund_entry,'1301',returned_cost,0,'Persediaan kembali'),
          (refund.tenant_id,refund_entry,'5101',0,returned_cost,'Pembalikan HPP'); end if;
      end if;
      if refunded_total+refund.amount_minor>=sale.total_minor then update public.sales set status='refunded',updated_at=now(),version=version+1 where id=sale.id; end if;
    end if;
  end if;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(coalesce(request.tenant_id,refund.tenant_id),actor,'approval.resolve',case when request.id is null then 'refund' else 'approval_request' end,target_approval_id::text,'success',jsonb_build_object('decision',decision,'note',decision_note));
end $$;

create or replace function public.prepare_approved_midtrans_refund(target_refund_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());refund public.refunds%rowtype;sale public.sales%rowtype;payment public.payments%rowtype;member public.memberships%rowtype;posted_total bigint;
begin
  select * into refund from public.refunds where id=target_refund_id and status='pending' for update;
  if refund.id is null then raise exception 'refund_not_found'; end if;
  select * into member from public.memberships where tenant_id=refund.tenant_id and user_id=actor and active limit 1;
  if member.role not in ('owner','business_manager','branch_manager','supervisor') or not private.can_access_branch(refund.tenant_id,refund.branch_id) then raise exception 'approval_access_denied'; end if;
  if coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'mfa_required'; end if;
  select * into sale from public.sales where id=refund.sale_id and tenant_id=refund.tenant_id for update;
  if sale.id is null or sale.payment_method<>'qris' then raise exception 'qris_sale_not_refundable'; end if;
  select coalesce(sum(amount_minor),0) into posted_total from public.refunds where tenant_id=refund.tenant_id and sale_id=refund.sale_id and status='posted';
  if posted_total+refund.amount_minor>sale.total_minor then raise exception 'invalid_refund_amount'; end if;
  select * into payment from public.payments where tenant_id=refund.tenant_id and sale_id=refund.sale_id and provider='midtrans' limit 1;
  if payment.id is null then raise exception 'midtrans_payment_not_found'; end if;
  update public.refunds set approved_by=actor,provider='midtrans',provider_reference=refund.id::text where id=refund.id;
  return jsonb_build_object('refundId',refund.id,'orderId',payment.provider_reference,'amount',refund.amount_minor,'reason',refund.reason);
end $$;

create or replace function public.register_current_device(target_device_id uuid,target_branch_id uuid,device_label text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());branch public.branches%rowtype;member public.memberships%rowtype;existing public.devices%rowtype;
begin
  select * into branch from public.branches where id=target_branch_id and active;
  select * into member from public.memberships where tenant_id=branch.tenant_id and user_id=actor and active limit 1;
  if branch.id is null or member.id is null or not private.can_access_branch(branch.tenant_id,branch.id) then raise exception 'branch_access_denied'; end if;
  select * into existing from public.devices where id=target_device_id;
  if existing.id is not null and (existing.tenant_id<>branch.tenant_id or existing.status='revoked') then raise exception 'device_revoked'; end if;
  insert into public.devices(id,tenant_id,branch_id,label,status,last_seen_at)
  values(target_device_id,branch.tenant_id,branch.id,left(coalesce(nullif(trim(device_label),''),'Android'),120),'active',now())
  on conflict(id) do update set branch_id=excluded.branch_id,label=excluded.label,last_seen_at=now(),updated_at=now();
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result)
  values(branch.tenant_id,actor,target_device_id,'device.register','device',target_device_id::text,'success');
end $$;

revoke all on table public.role_permissions from public,anon;
grant select on public.role_permissions to authenticated;
revoke all on function public.list_staff_access(),public.update_staff_access(uuid,public.membership_role,uuid[],boolean),public.cancel_staff_invitation(uuid),public.resolve_approval_request(uuid,text,text),public.prepare_approved_midtrans_refund(uuid),public.register_current_device(uuid,uuid,text) from public,anon;
grant execute on function public.list_staff_access(),public.update_staff_access(uuid,public.membership_role,uuid[],boolean),public.cancel_staff_invitation(uuid),public.resolve_approval_request(uuid,text,text),public.prepare_approved_midtrans_refund(uuid),public.register_current_device(uuid,uuid,text) to authenticated;

commit;
