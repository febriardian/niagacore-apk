begin;

create table if not exists public.ai_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  output_id uuid not null,
  actor_id uuid not null references auth.users(id),
  rating text not null check(rating in ('helpful','incorrect','unsafe')),
  note text,
  created_at timestamptz not null default now(),
  foreign key(tenant_id,output_id) references public.ai_insights(tenant_id,id) on delete cascade,
  unique(tenant_id,output_id,actor_id)
);
alter table public.ai_feedback enable row level security;
drop policy if exists ai_feedback_select_member on public.ai_feedback;
create policy ai_feedback_select_member on public.ai_feedback for select to authenticated
  using(private.is_tenant_member(tenant_id));

create or replace function public.submit_ai_feedback(
  target_output_id uuid, feedback_rating text, feedback_note text default null
) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); target_tenant uuid;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  if feedback_rating not in ('helpful','incorrect','unsafe') then raise exception 'invalid_feedback'; end if;
  select tenant_id into target_tenant from public.ai_insights where id=target_output_id;
  if target_tenant is null or not private.is_tenant_member(target_tenant) then raise exception 'tenant_access_denied'; end if;
  insert into public.ai_feedback(tenant_id,output_id,actor_id,rating,note)
  values(target_tenant,target_output_id,actor,feedback_rating,nullif(left(feedback_note,500),''))
  on conflict(tenant_id,output_id,actor_id) do update
    set rating=excluded.rating,note=excluded.note,created_at=now();
end;
$$;
revoke all on function public.submit_ai_feedback(uuid,text,text) from public;
grant execute on function public.submit_ai_feedback(uuid,text,text) to authenticated;

commit;
