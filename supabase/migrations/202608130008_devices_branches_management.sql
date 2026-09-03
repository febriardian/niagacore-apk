begin;

alter table public.devices add column if not exists platform text;
alter table public.devices add column if not exists model text;
alter table public.devices add column if not exists os_version text;
alter table public.devices add column if not exists app_version text;

create or replace function public.register_current_device_v2(
  target_device_id uuid,target_branch_id uuid,device_label text,
  device_platform text,device_model text,device_os_version text,device_app_version text
) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());branch public.branches%rowtype;member public.memberships%rowtype;existing public.devices%rowtype;is_new boolean:=false;
begin
  select * into branch from public.branches where id=target_branch_id and active;
  select * into member from public.memberships where tenant_id=branch.tenant_id and user_id=actor and active limit 1;
  if branch.id is null or member.id is null or not private.can_access_branch(branch.tenant_id,branch.id) then raise exception 'branch_access_denied'; end if;
  select * into existing from public.devices where id=target_device_id;
  if existing.id is not null and (existing.tenant_id<>branch.tenant_id or existing.status='revoked') then raise exception 'device_revoked'; end if;
  is_new:=existing.id is null;
  insert into public.devices(id,tenant_id,branch_id,label,status,last_seen_at,platform,model,os_version,app_version)
  values(target_device_id,branch.tenant_id,branch.id,left(coalesce(nullif(trim(device_label),''),'Android'),120),'active',now(),left(device_platform,40),left(device_model,120),left(device_os_version,40),left(device_app_version,40))
  on conflict(id) do update set branch_id=excluded.branch_id,label=excluded.label,last_seen_at=now(),platform=excluded.platform,model=excluded.model,os_version=excluded.os_version,app_version=excluded.app_version,updated_at=now();
  if is_new or existing.branch_id<>branch.id then
    insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result,metadata)
    values(branch.tenant_id,actor,target_device_id,case when is_new then 'device.register' else 'device.branch_changed' end,'device',target_device_id::text,'success',jsonb_build_object('branchId',branch.id,'model',device_model));
  end if;
end $$;

create or replace function public.revoke_registered_device(target_device_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());target public.devices%rowtype;actor_role public.membership_role;
begin
  select * into target from public.devices where id=target_device_id;
  select role into actor_role from public.memberships where tenant_id=target.tenant_id and user_id=actor and active limit 1;
  if target.id is null then raise exception 'device_not_found'; end if;
  if actor_role not in ('owner','business_manager') then raise exception 'permission_denied'; end if;
  update public.devices set status='revoked',updated_at=now() where id=target.id;
  insert into public.audit_events(tenant_id,actor_id,device_id,action,resource_type,resource_id,result)
  values(target.tenant_id,actor,target.id,'device.revoke','device',target.id::text,'success');
end $$;

create or replace function public.create_business_branch(target_name text,target_code text)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());member public.memberships%rowtype;business_id uuid;new_id uuid;
begin
  select * into member from public.memberships where user_id=actor and active and role in ('owner','business_manager') limit 1;
  if member.id is null then raise exception 'permission_denied'; end if;
  if char_length(trim(target_name))<2 or target_code !~ '^[A-Z0-9_-]{2,20}$' then raise exception 'invalid_branch'; end if;
  select id into business_id from public.businesses where tenant_id=member.tenant_id order by created_at limit 1;
  insert into public.branches(tenant_id,business_id,name,code) values(member.tenant_id,business_id,trim(target_name),target_code) returning id into new_id;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result,metadata)
  values(member.tenant_id,actor,'branch.create','branch',new_id::text,'success',jsonb_build_object('name',trim(target_name),'code',target_code));
  return new_id;
end $$;

revoke all on function public.register_current_device_v2(uuid,uuid,text,text,text,text,text),public.revoke_registered_device(uuid),public.create_business_branch(text,text) from public,anon;
grant execute on function public.register_current_device_v2(uuid,uuid,text,text,text,text,text),public.revoke_registered_device(uuid),public.create_business_branch(text,text) to authenticated;

commit;
