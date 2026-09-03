begin;

create or replace function private.platform_admin_permissions()
returns text[] language sql stable security definer set search_path='' as $$
  select case role
    when 'super_admin' then array['dashboard.read','merchant.read','merchant.review','device.read','device.manage','wallet.read','payout.account.verify','payout.read','payout.review','payout.pay','payment.read','payment.reconcile','release.manage','release.publish','feature_flag.manage','system.read','system.manage','system.verify','incident.manage','support.manage','nia.read','admin.manage','admin.invite','audit.read']::text[]
    when 'admin' then array['dashboard.read','merchant.read','merchant.review','device.read','device.manage','wallet.read','payout.account.verify','payout.read','payout.review','payout.pay','payment.read','payment.reconcile','release.manage','release.publish','feature_flag.manage','system.read','system.manage','system.verify','incident.manage','support.manage','nia.read','audit.read']::text[]
    when 'finance_admin' then array['dashboard.read','merchant.read','wallet.read','payout.account.verify','payout.read','payout.review','payout.pay','payment.read','payment.reconcile','audit.read']::text[]
    when 'operations_admin' then array['dashboard.read','merchant.read','merchant.review','device.read','device.manage','payment.read','payment.reconcile','feature_flag.manage','system.read','system.manage','incident.manage','support.manage','nia.read']::text[]
    when 'support' then array['dashboard.read','merchant.read','device.read','system.read','incident.manage','support.manage']::text[]
    when 'release_manager' then array['dashboard.read','release.manage','release.publish','feature_flag.manage','system.read']::text[]
    when 'auditor' then array['dashboard.read','merchant.read','wallet.read','payout.read','payment.read','system.read','nia.read','audit.read']::text[]
    else array[]::text[] end
  from public.platform_admins where user_id=(select auth.uid()) and active limit 1;
$$;

create table public.platform_admin_invitations(
  id uuid primary key default gen_random_uuid(),
  email text not null check(email=lower(trim(email)) and email~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role text not null check(role in('admin','finance_admin','operations_admin','support','release_manager','auditor')),
  status text not null default 'pending' check(status in('pending','sent','accepted','failed','expired','cancelled')),
  invited_by uuid not null references auth.users(id), invited_user_id uuid references auth.users(id),
  note text not null, error_code text, expires_at timestamptz not null default now()+interval '7 days',
  sent_at timestamptz,accepted_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create unique index platform_admin_invitation_pending_email_idx on public.platform_admin_invitations(email) where status in('pending','sent');
alter table public.platform_admin_invitations enable row level security;
create policy platform_admin_invitation_read on public.platform_admin_invitations for select to authenticated using(private.platform_admin_has_permission('admin.manage'));

create or replace function public.admin_merchant_detail(target_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.platform_admin_has_permission('merchant.read') then raise exception 'permission_denied'; end if;
  if not exists(select 1 from public.tenants where id=target_tenant_id) then raise exception 'merchant_not_found'; end if;
  return jsonb_build_object(
    'merchant',(select jsonb_build_object('tenantId',t.id,'name',t.name,'slug',t.slug,'language',t.default_language,'createdAt',t.created_at,'ownerName',v.owner_name,'ownerPhone',v.owner_phone,'businessName',v.business_name,'businessAddress',v.business_address,'status',v.status,'qrisEnabled',v.qris_enabled,'reviewNote',v.review_note,'submittedAt',v.submitted_at,'reviewedAt',v.reviewed_at) from public.tenants t left join public.merchant_verifications v on v.tenant_id=t.id where t.id=target_tenant_id),
    'businesses',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'modules',b.modules,'currency',b.currency,'createdAt',b.created_at) order by b.created_at) from public.businesses b where b.tenant_id=target_tenant_id),'[]'::jsonb),
    'branches',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'businessId',b.business_id,'name',b.name,'code',b.code,'active',b.active,'createdAt',b.created_at) order by b.created_at) from public.branches b where b.tenant_id=target_tenant_id),'[]'::jsonb),
    'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'userId',m.user_id,'email',u.email,'role',m.role,'active',m.active,'createdAt',m.created_at) order by m.created_at) from public.memberships m left join auth.users u on u.id=m.user_id where m.tenant_id=target_tenant_id),'[]'::jsonb),
    'devices',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'branchId',d.branch_id,'branchName',b.name,'label',d.label,'status',d.status,'lastSeenAt',d.last_seen_at,'syncCursor',d.sync_cursor,'createdAt',d.created_at) order by d.last_seen_at desc nulls last) from public.devices d join public.branches b on b.id=d.branch_id where d.tenant_id=target_tenant_id),'[]'::jsonb),
    'wallet',(select jsonb_build_object('pendingMinor',w.pending_minor,'availableMinor',w.available_minor,'reserveMinor',w.reserve_minor,'lockedMinor',w.withdrawal_locked_minor,'updatedAt',w.updated_at) from public.merchant_wallets w where w.tenant_id=target_tenant_id),
    'counts',jsonb_build_object('sales30d',(select count(*) from public.sales where tenant_id=target_tenant_id and occurred_at>=now()-interval '30 days'),'payments30d',(select count(*) from public.payments where tenant_id=target_tenant_id and created_at>=now()-interval '30 days'),'openWithdrawals',(select count(*) from public.withdrawal_requests where tenant_id=target_tenant_id and status in('requested','approved')))
  );
end $$;

create or replace function public.admin_set_device_status(target_device_id uuid,target_status text,target_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare row_device public.devices%rowtype;
begin
  if not private.platform_admin_has_permission('device.manage') then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if target_status not in('active','revoked') then raise exception 'invalid_device_status'; end if;
  if char_length(trim(coalesce(target_reason,'')))<8 then raise exception 'action_reason_required'; end if;
  select * into row_device from public.devices where id=target_device_id for update;
  if row_device.id is null then raise exception 'device_not_found'; end if;
  update public.devices set status=target_status::public.device_status,updated_at=now() where id=target_device_id;
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result,reason)
  values(row_device.tenant_id,(select auth.uid()),row_device.id,'device.status.'||target_status,'device',row_device.id::text,'success',trim(target_reason));
end $$;

create or replace function public.admin_create_platform_admin_invitation(target_email text,target_role text,target_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare invitation_id uuid; normalized text:=lower(trim(target_email));
begin
  if not private.platform_admin_has_permission('admin.invite') then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if target_role not in('admin','finance_admin','operations_admin','support','release_manager','auditor') then raise exception 'invalid_admin_role'; end if;
  if char_length(trim(coalesce(target_note,'')))<8 then raise exception 'invitation_note_required'; end if;
  update public.platform_admin_invitations set status='expired',updated_at=now() where email=normalized and status in('pending','sent') and expires_at<=now();
  insert into public.platform_admin_invitations(email,role,invited_by,note) values(normalized,target_role,(select auth.uid()),trim(target_note)) returning id into invitation_id;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,reason,metadata) values((select auth.uid()),'platform_admin.invite.create','platform_admin_invitation',invitation_id::text,'success',trim(target_note),jsonb_build_object('email',normalized,'role',target_role));
  return invitation_id;
end $$;

create or replace function public.complete_platform_admin_invitation(target_invitation_id uuid,target_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare invitation public.platform_admin_invitations%rowtype;
begin
  if (select auth.role())<>'service_role' then raise exception 'service_role_required'; end if;
  select * into invitation from public.platform_admin_invitations where id=target_invitation_id and status='pending' for update;
  if invitation.id is null or invitation.expires_at<=now() then raise exception 'invitation_not_pending'; end if;
  insert into public.platform_admins(user_id,email,role,active) values(target_user_id,invitation.email,invitation.role,true)
  on conflict(user_id) do update set email=excluded.email,role=excluded.role,active=true;
  update public.platform_admin_invitations set status='sent',invited_user_id=target_user_id,sent_at=now(),updated_at=now() where id=invitation.id;
end $$;

create or replace function public.fail_platform_admin_invitation(target_invitation_id uuid,target_error_code text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if (select auth.role())<>'service_role' then raise exception 'service_role_required'; end if;
  update public.platform_admin_invitations set status='failed',error_code=left(target_error_code,120),updated_at=now() where id=target_invitation_id and status='pending';
end $$;

create or replace function public.admin_search_audit_events(search_text text default null,action_filter text default null,result_filter text default null,actor_filter uuid default null,tenant_filter uuid default null,occurred_from timestamptz default null,occurred_to timestamptz default null,before_id bigint default null,page_size integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare size integer:=greatest(10,least(coalesce(page_size,25),100));
begin
  if not private.platform_admin_has_permission('audit.read') then raise exception 'permission_denied'; end if;
  return jsonb_build_object('items',coalesce((select jsonb_agg(row_to_json(x)) from(select e.id,e.tenant_id "tenantId",t.name "tenantName",e.actor_id "actorId",u.email "actorEmail",e.action,e.resource_type "resourceType",e.resource_id "resourceId",e.result,e.reason,e.metadata,e.occurred_at "occurredAt" from public.audit_events e left join public.tenants t on t.id=e.tenant_id left join auth.users u on u.id=e.actor_id where (before_id is null or e.id<before_id) and (action_filter is null or e.action=action_filter) and (result_filter is null or e.result=result_filter) and (actor_filter is null or e.actor_id=actor_filter) and (tenant_filter is null or e.tenant_id=tenant_filter) and (occurred_from is null or e.occurred_at>=occurred_from) and (occurred_to is null or e.occurred_at<=occurred_to) and (search_text is null or e.action ilike '%'||search_text||'%' or coalesce(e.reason,'') ilike '%'||search_text||'%' or coalesce(e.resource_id,'') ilike '%'||search_text||'%') order by e.id desc limit size)x),'[]'::jsonb),'nextCursor',(select min(id) from(select e.id from public.audit_events e where (before_id is null or e.id<before_id) order by e.id desc limit size)x));
end $$;

revoke all on function public.admin_merchant_detail(uuid),public.admin_set_device_status(uuid,text,text),public.admin_create_platform_admin_invitation(text,text,text),public.admin_search_audit_events(text,text,text,uuid,uuid,timestamptz,timestamptz,bigint,integer) from public,anon;
grant execute on function public.admin_merchant_detail(uuid),public.admin_set_device_status(uuid,text,text),public.admin_create_platform_admin_invitation(text,text,text),public.admin_search_audit_events(text,text,text,uuid,uuid,timestamptz,timestamptz,bigint,integer) to authenticated;
revoke all on function public.complete_platform_admin_invitation(uuid,uuid),public.fail_platform_admin_invitation(uuid,text) from public,anon,authenticated;
grant execute on function public.complete_platform_admin_invitation(uuid,uuid),public.fail_platform_admin_invitation(uuid,text) to service_role;

commit;
