begin;

create or replace function public.reserve_ai_request(target_tenant_id uuid, target_business_id uuid, feature_name text, model_name text)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  actor_minute_count integer;
  tenant_day_count integer;
begin
  if actor is null or not private.is_tenant_member(target_tenant_id) then return false; end if;
  if not exists(select 1 from public.accounting_settings where tenant_id=target_tenant_id and business_id=target_business_id and cloud_ai_enabled) then return false; end if;
  select count(*) into actor_minute_count from public.ai_usage where tenant_id=target_tenant_id and actor_id=actor and created_at>now()-interval '1 minute';
  select count(*) into tenant_day_count from public.ai_usage where tenant_id=target_tenant_id and created_at>now()-interval '24 hours';
  if actor_minute_count>=12 or tenant_day_count>=500 then return false; end if;
  insert into public.ai_usage(tenant_id,actor_id,feature,model) values(target_tenant_id,actor,left(feature_name,80),left(model_name,120));
  return true;
end; $$;

revoke all on function public.reserve_ai_request(uuid,uuid,text,text) from public;
grant execute on function public.reserve_ai_request(uuid,uuid,text,text) to authenticated;

commit;
