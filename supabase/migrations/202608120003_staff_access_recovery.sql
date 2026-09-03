begin;

create or replace function public.list_staff_access()
returns table(
  id uuid,
  email text,
  display_name text,
  role public.membership_role,
  active boolean,
  branch_names text[]
) language plpgsql security definer set search_path='' stable as $$
declare actor uuid := (select auth.uid()); target_tenant uuid;
begin
  select m.tenant_id into target_tenant
  from public.memberships m
  where m.user_id=actor and m.active and m.role='owner'
  order by m.created_at limit 1;
  if target_tenant is null then raise exception 'owner_required'; end if;
  return query
  select m.id,
    coalesce(u.email,''),
    p.display_name,
    m.role,
    m.active,
    coalesce(array_agg(distinct b.name) filter(where b.id is not null),'{}'::text[])
  from public.memberships m
  join auth.users u on u.id=m.user_id
  left join public.profiles p on p.id=m.user_id
  left join public.membership_branches mb on mb.tenant_id=m.tenant_id and mb.membership_id=m.id
  left join public.branches b on b.id=mb.branch_id and b.tenant_id=m.tenant_id
  where m.tenant_id=target_tenant
  group by m.id,u.email,p.display_name,m.role,m.active,m.created_at
  order by case m.role when 'owner' then 0 when 'supervisor' then 1 else 2 end,m.created_at;
end; $$;

create or replace function public.cancel_staff_invitation(target_invitation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid := (select auth.uid()); invitation public.staff_invitations%rowtype;
begin
  select * into invitation from public.staff_invitations where id=target_invitation_id for update;
  if invitation.id is null then raise exception 'invitation_not_found'; end if;
  if not exists(select 1 from public.memberships m where m.tenant_id=invitation.tenant_id and m.user_id=actor and m.active and m.role='owner') then raise exception 'owner_required'; end if;
  if invitation.status<>'pending' then raise exception 'invitation_not_pending'; end if;
  update public.staff_invitations set status='revoked',updated_at=now() where id=invitation.id;
  insert into public.audit_events(tenant_id,actor_id,action,resource_type,resource_id,result)
  values(invitation.tenant_id,actor,'staff.invitation.cancel','staff_invitation',invitation.id::text,'success');
end; $$;

revoke all on function public.list_staff_access() from public,anon;
grant execute on function public.list_staff_access() to authenticated;
revoke all on function public.cancel_staff_invitation(uuid) from public,anon;
grant execute on function public.cancel_staff_invitation(uuid) to authenticated;

commit;
