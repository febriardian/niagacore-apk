begin;

create or replace function public.admin_create_platform_admin_invitation(target_email text,target_role text,target_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare invitation_id uuid; normalized text:=lower(trim(target_email));
begin
  if not private.platform_admin_has_permission('admin.invite') then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if target_role not in('admin','finance_admin','operations_admin','support','release_manager','auditor') then raise exception 'invalid_admin_role'; end if;
  if char_length(trim(coalesce(target_note,'')))<8 then raise exception 'invitation_note_required'; end if;
  if exists(select 1 from public.platform_admins where lower(coalesce(email,''))=normalized and active) then raise exception 'invitation_already_active'; end if;
  update public.platform_admin_invitations set status='expired',updated_at=now() where email=normalized and status in('pending','sent') and expires_at<=now();
  if exists(select 1 from public.platform_admin_invitations where email=normalized and status in('pending','sent')) then raise exception 'invitation_already_pending'; end if;
  insert into public.platform_admin_invitations(email,role,invited_by,note) values(normalized,target_role,(select auth.uid()),trim(target_note)) returning id into invitation_id;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,reason,metadata)
  values((select auth.uid()),'platform_admin.invite.create','platform_admin_invitation',invitation_id::text,'success',trim(target_note),jsonb_build_object('email',normalized,'role',target_role));
  return invitation_id;
end $$;

-- Pengiriman email hanya menandai undangan sebagai terkirim. Akses belum aktif.
create or replace function public.complete_platform_admin_invitation(target_invitation_id uuid,target_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if (select auth.role())<>'service_role' then raise exception 'service_role_required'; end if;
  update public.platform_admin_invitations set status='sent',invited_user_id=target_user_id,sent_at=now(),updated_at=now()
  where id=target_invitation_id and status='pending' and expires_at>now();
  if not found then raise exception 'invitation_not_pending'; end if;
end $$;

-- Penerima baru memperoleh akses setelah link undangan dibuka dan sesi email terkonfirmasi.
create or replace function public.accept_my_platform_admin_invitation()
returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); actor_email text; invitation public.platform_admin_invitations%rowtype;
begin
  if actor is null then return false; end if;
  select lower(email) into actor_email from auth.users where id=actor and email_confirmed_at is not null;
  if actor_email is null then return false; end if;
  update public.platform_admin_invitations set status='expired',updated_at=now() where email=actor_email and status in('pending','sent') and expires_at<=now();
  select * into invitation from public.platform_admin_invitations
  where email=actor_email and status='sent' and expires_at>now() and (invited_user_id is null or invited_user_id=actor)
  order by created_at desc limit 1 for update;
  if invitation.id is null then return false; end if;
  insert into public.platform_admins(user_id,email,role,active) values(actor,actor_email,invitation.role,true)
  on conflict(user_id) do update set email=excluded.email,role=excluded.role,active=true;
  update public.platform_admin_invitations set status='accepted',invited_user_id=actor,accepted_at=now(),updated_at=now() where id=invitation.id;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,metadata)
  values(actor,'platform_admin.invite.accept','platform_admin_invitation',invitation.id::text,'success',jsonb_build_object('email',actor_email,'role',invitation.role));
  return true;
end $$;

create or replace function public.admin_team_snapshot()
returns jsonb language sql stable security definer set search_path='' as $$
  select case when not private.platform_admin_has_permission('admin.manage') then '[]'::jsonb else
    coalesce(jsonb_agg(to_jsonb(x) order by x."createdAt"),'[]'::jsonb) end
  from (
    select a.user_id::text "userId",null::text "invitationId",coalesce(a.email,u.email) email,a.role,
      a.active,case when a.active then 'active' else 'inactive' end status,a.created_at "createdAt",null::timestamptz "expiresAt",null::text "errorCode"
    from public.platform_admins a left join auth.users u on u.id=a.user_id
    union all
    select coalesce(i.invited_user_id::text,'invitation:'||i.id::text),i.id::text,i.email,i.role,false,i.status,i.created_at,i.expires_at,i.error_code
    from public.platform_admin_invitations i where i.status in('pending','sent','failed','expired')
  ) x;
$$;

create or replace function public.admin_cancel_platform_admin_invitation(target_invitation_id uuid,target_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); actor_role text;
begin
  select role into actor_role from public.platform_admins where user_id=actor and active;
  if actor_role<>'super_admin' then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if char_length(trim(coalesce(target_reason,'')))<8 then raise exception 'action_reason_required'; end if;
  update public.platform_admin_invitations set status='cancelled',updated_at=now() where id=target_invitation_id and status in('pending','sent');
  if not found then raise exception 'invitation_not_pending'; end if;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,reason)
  values(actor,'platform_admin.invite.cancel','platform_admin_invitation',target_invitation_id::text,'success',trim(target_reason));
end $$;

create or replace function public.admin_delete_platform_admin(target_user_id uuid,target_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); actor_role text; target_role text; target_email text;
begin
  select role into actor_role from public.platform_admins where user_id=actor and active;
  if actor_role<>'super_admin' then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if target_user_id=actor then raise exception 'cannot_delete_self'; end if;
  if char_length(trim(coalesce(target_reason,'')))<8 then raise exception 'action_reason_required'; end if;
  select role,lower(email) into target_role,target_email from public.platform_admins where user_id=target_user_id for update;
  if target_role is null then raise exception 'platform_admin_not_found'; end if;
  if target_role='super_admin' then raise exception 'cannot_delete_super_admin'; end if;
  delete from public.platform_admins where user_id=target_user_id;
  update public.platform_admin_invitations set status='cancelled',updated_at=now() where invited_user_id=target_user_id and status in('pending','sent');
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,reason,metadata)
  values(actor,'platform_admin.access.delete','platform_admin',target_user_id::text,'success',trim(target_reason),jsonb_build_object('email',target_email,'role',target_role));
end $$;

-- Koreksi akun yang sebelumnya diaktifkan oleh bug saat email baru dikirim.
delete from public.platform_admins a using public.platform_admin_invitations i
where i.invited_user_id=a.user_id and i.status='sent' and a.role<>'super_admin';

revoke all on function public.accept_my_platform_admin_invitation(),public.admin_team_snapshot(),
  public.admin_cancel_platform_admin_invitation(uuid,text),public.admin_delete_platform_admin(uuid,text) from public,anon;
grant execute on function public.accept_my_platform_admin_invitation(),public.admin_team_snapshot(),
  public.admin_cancel_platform_admin_invitation(uuid,text),public.admin_delete_platform_admin(uuid,text) to authenticated;

commit;
