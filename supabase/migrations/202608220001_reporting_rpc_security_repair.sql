begin;

-- Repair reporting functions that may still be SECURITY INVOKER on projects
-- whose older migrations were recorded with `migration repair`. Without this,
-- authenticated clients execute references to the private schema themselves
-- and Postgres returns: permission denied for schema private.
alter function public.get_branch_dashboard(uuid, integer) security definer;
alter function public.get_branch_dashboard(uuid, integer) set search_path = '';

alter function public.get_branch_management_report(uuid) security definer;
alter function public.get_branch_management_report(uuid) set search_path = '';

revoke all on function public.get_branch_dashboard(uuid, integer) from public, anon;
grant execute on function public.get_branch_dashboard(uuid, integer) to authenticated;

revoke all on function public.get_branch_management_report(uuid) from public, anon;
grant execute on function public.get_branch_management_report(uuid) to authenticated;

commit;
