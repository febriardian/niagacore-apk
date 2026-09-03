begin;

-- NiagaCore 1.4: repair the production staff RPC contract.
-- PostgreSQL requires every RETURN QUERY expression to match RETURNS TABLE
-- exactly; auth.users.email and profile/branch names may be varchar/domain
-- values in hosted projects, so cast them explicitly to text.
create or replace function public.list_staff_access()
returns table(
  id uuid,
  email text,
  display_name text,
  role public.membership_role,
  active boolean,
  branch_names text[]
)
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  actor uuid := (select auth.uid());
  target_tenant uuid;
begin
  select m.tenant_id into target_tenant
  from public.memberships m
  where m.user_id=actor and m.active and m.role='owner'
  order by m.created_at
  limit 1;

  if target_tenant is null then raise exception 'owner_required'; end if;

  return query
  select
    m.id,
    coalesce(u.email::text, ''::text),
    p.display_name::text,
    m.role,
    m.active,
    coalesce(
      array_agg(distinct b.name::text) filter(where b.id is not null),
      array[]::text[]
    )::text[]
  from public.memberships m
  join auth.users u on u.id=m.user_id
  left join public.profiles p on p.id=m.user_id
  left join public.membership_branches mb
    on mb.tenant_id=m.tenant_id and mb.membership_id=m.id
  left join public.branches b
    on b.id=mb.branch_id and b.tenant_id=m.tenant_id
  where m.tenant_id=target_tenant
  group by m.id,u.email,p.display_name,m.role,m.active,m.created_at
  order by
    case m.role when 'owner' then 0 when 'supervisor' then 1 else 2 end,
    m.created_at;
end;
$$;

revoke all on function public.list_staff_access() from public;
grant execute on function public.list_staff_access() to authenticated;

commit;
