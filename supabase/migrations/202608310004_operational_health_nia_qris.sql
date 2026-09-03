begin;

create table public.qris_recovery_events(
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null,
  device_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid,
  outcome text not null check(outcome in('session_found','not_found')),
  created_at timestamptz not null default now(),
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  foreign key(tenant_id,device_id) references public.devices(tenant_id,id),
  foreign key(tenant_id,sale_id) references public.sales(tenant_id,id)
);
create index qris_recovery_scope_idx on public.qris_recovery_events(tenant_id,branch_id,created_at desc);
alter table public.qris_recovery_events enable row level security;
create policy qris_recovery_events_manager_read on public.qris_recovery_events for select to authenticated
using(private.current_role(tenant_id) in('owner','business_manager','branch_manager','supervisor'));
grant select on public.qris_recovery_events to authenticated;

create or replace function public.recover_qris_payment_session(target_branch_id uuid,target_device_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); tenant uuid; recovered jsonb; recovered_sale uuid;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  select b.tenant_id into tenant from public.branches b
  join public.devices d on d.tenant_id=b.tenant_id and d.branch_id=b.id
  where b.id=target_branch_id and d.id=target_device_id and d.status='active'
    and private.can_access_branch(b.tenant_id,b.id);
  if tenant is null then raise exception 'device_or_branch_access_denied'; end if;
  recovered:=public.get_recoverable_qris_payment(target_branch_id,target_device_id);
  recovered_sale:=nullif(recovered->>'saleId','')::uuid;
  insert into public.qris_recovery_events(tenant_id,branch_id,device_id,user_id,sale_id,outcome)
  values(tenant,target_branch_id,target_device_id,actor,recovered_sale,
    case when recovered_sale is null then 'not_found' else 'session_found' end);
  return recovered;
end $$;
revoke all on function public.recover_qris_payment_session(uuid,uuid) from public,anon;
grant execute on function public.recover_qris_payment_session(uuid,uuid) to authenticated;

create or replace function public.get_operational_health(
  target_tenant_id uuid,target_business_id uuid,target_branch_id uuid
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor_role public.membership_role;
begin
  actor_role:=private.current_role(target_tenant_id);
  if actor_role not in('owner','business_manager','branch_manager','supervisor')
    or not private.can_access_branch(target_tenant_id,target_branch_id)
    or not exists(select 1 from public.businesses b where b.tenant_id=target_tenant_id and b.id=target_business_id)
  then raise exception 'operational_health_access_denied'; end if;
  return jsonb_build_object(
    'checkedAt',now(),
    'sync',jsonb_build_object(
      'openFailures',(select count(*) from public.sync_failure_events f where f.tenant_id=target_tenant_id and f.branch_id=target_branch_id and f.status='requires_review'),
      'openConflicts',(select count(*) from public.sync_conflict_reviews c where c.tenant_id=target_tenant_id and c.branch_id=target_branch_id and c.status='requires_review'),
      'lastAcceptedAt',(select max(m.accepted_at) from public.sync_mutations m where m.tenant_id=target_tenant_id and m.branch_id=target_branch_id)
    ),
    'qris',jsonb_build_object(
      'pending',(select count(*) from public.sales s where s.tenant_id=target_tenant_id and s.business_id=target_business_id and s.branch_id=target_branch_id and s.payment_method='qris' and s.status='pending_payment'),
      'recoverable',(select count(*) from public.sales s join public.payments p on p.tenant_id=s.tenant_id and p.sale_id=s.id and p.method='qris' where s.tenant_id=target_tenant_id and s.business_id=target_business_id and s.branch_id=target_branch_id and s.status='pending_payment' and p.metadata?'qrisSession'),
      'lastRecoveryAt',(select max(e.created_at) from public.qris_recovery_events e where e.tenant_id=target_tenant_id and e.branch_id=target_branch_id),
      'lastRecoveryOutcome',(select e.outcome from public.qris_recovery_events e where e.tenant_id=target_tenant_id and e.branch_id=target_branch_id order by e.created_at desc limit 1)
    ),
    'nia',jsonb_build_object(
      'activeModels',(select count(*) from public.nia_model_versions v where v.status='active'),
      'latestDatasetAt',(select max(d.created_at) from public.nia_dataset_versions d where d.tenant_id=target_tenant_id and d.business_id=target_business_id and (d.branch_id=target_branch_id or d.branch_id is null)),
      'driftAlerts7d',(select count(*) from public.nia_drift_measurements d where d.tenant_id=target_tenant_id and d.business_id=target_business_id and (d.branch_id=target_branch_id or d.branch_id is null) and d.status in('warning','drift') and d.measured_at>=now()-interval '7 days'),
      'calibratedAt',(select max(c.calibrated_at) from public.nia_anomaly_calibrations c where c.tenant_id=target_tenant_id and c.business_id=target_business_id and c.active),
      'calibrationSampleSize',(select c.sample_size from public.nia_anomaly_calibrations c where c.tenant_id=target_tenant_id and c.business_id=target_business_id and c.active order by c.version desc limit 1),
      'latestEvaluation',(select jsonb_build_object('status',r.status,'provider',r.provider,'model',r.model,'passedCases',r.passed_cases,'totalCases',r.total_cases,'groundingScore',r.grounding_score,'regressionScore',r.regression_score,'completedAt',r.completed_at) from public.nia_evaluation_runs r where r.status<>'running' order by r.started_at desc limit 1),
      'nextEvaluationAt',(select min(s.next_run_at) from public.nia_evaluation_schedules s where s.active)
    )
  );
end $$;
revoke all on function public.get_operational_health(uuid,uuid,uuid) from public,anon;
grant execute on function public.get_operational_health(uuid,uuid,uuid) to authenticated;

commit;
