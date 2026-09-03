begin;

-- Sending an invitation must not activate platform access. Access is created only
-- after the invited user has authenticated through the invitation flow.
create or replace function public.complete_platform_admin_invitation(target_invitation_id uuid,target_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare invitation public.platform_admin_invitations%rowtype;
begin
  if (select auth.role())<>'service_role' then raise exception 'service_role_required'; end if;
  select * into invitation from public.platform_admin_invitations where id=target_invitation_id and status='pending' for update;
  if invitation.id is null or invitation.expires_at<=now() then raise exception 'invitation_not_pending'; end if;
  update public.platform_admin_invitations
  set status='sent',invited_user_id=target_user_id,sent_at=now(),updated_at=now()
  where id=invitation.id;
end $$;

create or replace function public.accept_my_platform_admin_invitation()
returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); actor_email text; invitation public.platform_admin_invitations%rowtype;
begin
  if actor is null then return false; end if;
  select lower(email) into actor_email from auth.users where id=actor;
  select * into invitation from public.platform_admin_invitations
  where status='sent' and invited_user_id=actor and email=actor_email and expires_at>now()
  order by sent_at desc limit 1 for update;
  if invitation.id is null then return false; end if;
  insert into public.platform_admins(user_id,email,role,active)
  values(actor,invitation.email,invitation.role,true)
  on conflict(user_id) do update set email=excluded.email,role=excluded.role,active=true;
  update public.platform_admin_invitations set status='accepted',accepted_at=now(),updated_at=now() where id=invitation.id;
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,reason,metadata)
  values(actor,'platform_admin.invite.accept','platform_admin_invitation',invitation.id::text,'success','Undangan diterima',jsonb_build_object('email',invitation.email,'role',invitation.role));
  return true;
end $$;

-- Repair records produced by the old flow that activated access at send time.
delete from public.platform_admins admin
using public.platform_admin_invitations invitation
where invitation.status='sent' and invitation.accepted_at is null
  and invitation.invited_user_id=admin.user_id;

create or replace function public.admin_delete_platform_admin(target_user_id uuid,target_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); actor_role text; target_role text; target_email text;
begin
  select role into actor_role from public.platform_admins where user_id=actor and active;
  if actor_role<>'super_admin' then raise exception 'permission_denied'; end if;
  perform private.require_platform_admin_mfa();
  if target_user_id=actor then raise exception 'cannot_delete_self'; end if;
  if char_length(trim(coalesce(target_reason,'')))<8 then raise exception 'action_reason_required'; end if;
  select role,email into target_role,target_email from public.platform_admins where user_id=target_user_id for update;
  if target_role is null then raise exception 'platform_admin_not_found'; end if;
  if target_role='super_admin' then raise exception 'cannot_delete_super_admin'; end if;
  delete from public.platform_admins where user_id=target_user_id;
  update public.platform_admin_invitations set status='cancelled',updated_at=now()
  where invited_user_id=target_user_id and status in('pending','sent');
  insert into public.audit_events(actor_id,action,resource_type,resource_id,result,reason,metadata)
  values(actor,'platform_admin.delete','platform_admin',target_user_id::text,'success',trim(target_reason),jsonb_build_object('email',target_email,'role',target_role));
end $$;

revoke all on function public.accept_my_platform_admin_invitation(),public.admin_delete_platform_admin(uuid,text) from public,anon;
grant execute on function public.accept_my_platform_admin_invitation(),public.admin_delete_platform_admin(uuid,text) to authenticated;

commit;
