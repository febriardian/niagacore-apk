begin;

-- Cabang wajib dibuat pada usaha yang dipilih pengguna. Signature lama sengaja
-- dihapus karena memilih usaha pertama dalam tenant dan tidak aman untuk multiusaha.
drop function if exists public.create_business_branch(text,text);

create or replace function public.create_business_branch(
  target_business_id uuid,
  target_name text,
  target_code text
) returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid := (select auth.uid());
  target public.businesses%rowtype;
  normalized_code text := upper(trim(target_code));
  new_id uuid;
begin
  select b.* into target
  from public.businesses b
  join public.memberships m on m.tenant_id=b.tenant_id
  where b.id=target_business_id
    and m.user_id=actor
    and m.active
    and m.role in ('owner','business_manager')
  limit 1;

  if target.id is null then raise exception 'permission_denied'; end if;
  if char_length(trim(target_name)) not between 2 and 160
    or normalized_code !~ '^[A-Z0-9_-]{2,20}$'
  then raise exception 'invalid_branch'; end if;
  if exists(
    select 1 from public.branches
    where business_id=target.id and code=normalized_code
  ) then raise exception 'branch_code_exists'; end if;

  insert into public.branches(tenant_id,business_id,name,code)
  values(target.tenant_id,target.id,trim(target_name),normalized_code)
  returning id into new_id;

  insert into public.audit_events(
    tenant_id,actor_id,action,resource_type,resource_id,result,metadata
  ) values(
    target.tenant_id,actor,'branch.create','branch',new_id::text,'success',
    jsonb_build_object('businessId',target.id,'name',trim(target_name),'code',normalized_code)
  );
  return new_id;
end $$;

revoke all on function public.create_business_branch(uuid,text,text) from public,anon;
grant execute on function public.create_business_branch(uuid,text,text) to authenticated;

-- Piutang/utang memiliki branch_id, jadi kebijakan tenant-wide lama terlalu luas
-- untuk kasir dan staf cabang.
drop policy if exists read_subledger_documents on public.subledger_documents;
drop policy if exists subledger_documents_select_branch on public.subledger_documents;
create policy subledger_documents_select_branch on public.subledger_documents
for select to authenticated
using(private.can_access_branch(tenant_id,branch_id));

commit;
