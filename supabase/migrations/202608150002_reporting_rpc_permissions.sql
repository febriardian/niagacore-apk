begin;

-- The reporting RPCs call permission helpers in the private schema. As
-- security-invoker functions they failed before reaching their explicit branch
-- membership checks because authenticated users intentionally have no USAGE on
-- private. Run the function body as its owner while retaining the checks inside
-- each function and an empty search_path.
alter function public.get_branch_dashboard(uuid,integer) security definer;
alter function public.get_branch_dashboard(uuid,integer) set search_path='';
alter function public.get_branch_management_report(uuid) security definer;
alter function public.get_branch_management_report(uuid) set search_path='';

revoke all on function public.get_branch_dashboard(uuid,integer) from public,anon;
grant execute on function public.get_branch_dashboard(uuid,integer) to authenticated;
revoke all on function public.get_branch_management_report(uuid) from public,anon;
grant execute on function public.get_branch_management_report(uuid) to authenticated;

commit;
