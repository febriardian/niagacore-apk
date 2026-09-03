begin;

create table public.observability_job_runs(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  business_id uuid,
  branch_id uuid,
  job_name text not null check(job_name~'^[a-z][a-z0-9_.-]{2,99}$'),
  trigger_source text not null default 'manual',
  status text not null default 'running' check(status in('running','succeeded','partial','failed','cancelled')),
  trace_id text not null check(trace_id~'^[a-f0-9]{32}$'),
  root_span_id text not null check(root_span_id~'^[a-f0-9]{16}$'),
  attempt integer not null default 1 check(attempt>0),
  processed_count integer not null default 0 check(processed_count>=0),
  succeeded_count integer not null default 0 check(succeeded_count>=0),
  failed_count integer not null default 0 check(failed_count>=0),
  error_code text,error_message text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),completed_at timestamptz,duration_ms integer,
  foreign key(tenant_id,business_id) references public.businesses(tenant_id,id),
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id)
);
create index observability_jobs_scope_idx on public.observability_job_runs(tenant_id,business_id,branch_id,started_at desc);
create index observability_jobs_trace_idx on public.observability_job_runs(trace_id);

create table public.observability_spans(
  id bigint generated always as identity primary key,
  job_run_id uuid references public.observability_job_runs(id) on delete cascade,
  trace_id text not null check(trace_id~'^[a-f0-9]{32}$'),
  span_id text not null check(span_id~'^[a-f0-9]{16}$'),
  parent_span_id text check(parent_span_id is null or parent_span_id~'^[a-f0-9]{16}$'),
  name text not null,
  kind text not null default 'server' check(kind in('server','client','internal','producer','consumer')),
  status text not null default 'ok' check(status in('ok','error','unset')),
  attributes jsonb not null default '{}'::jsonb,
  events jsonb not null default '[]'::jsonb check(jsonb_typeof(events)='array'),
  started_at timestamptz not null,completed_at timestamptz not null,duration_ms integer not null check(duration_ms>=0),
  unique(trace_id,span_id)
);
create index observability_spans_trace_idx on public.observability_spans(trace_id,started_at);

alter table public.observability_job_runs enable row level security;
alter table public.observability_spans enable row level security;
create policy observability_jobs_manager_read on public.observability_job_runs for select to authenticated
using(tenant_id is not null and private.current_role(tenant_id) in('owner','business_manager','branch_manager','supervisor'));
create policy observability_spans_manager_read on public.observability_spans for select to authenticated
using(exists(select 1 from public.observability_job_runs j where j.id=observability_spans.job_run_id and j.tenant_id is not null and private.current_role(j.tenant_id) in('owner','business_manager','branch_manager','supervisor')));
grant select on public.observability_job_runs,public.observability_spans to authenticated;

create or replace function public.get_nia_governance_dashboard(
  target_tenant_id uuid,target_business_id uuid,target_branch_id uuid
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor_role public.membership_role;
begin
  actor_role:=private.current_role(target_tenant_id);
  if actor_role not in('owner','business_manager') or not private.can_access_branch(target_tenant_id,target_branch_id)
    or not exists(select 1 from public.businesses b where b.tenant_id=target_tenant_id and b.id=target_business_id)
  then raise exception 'nia_governance_access_denied'; end if;
  return jsonb_build_object(
    'generatedAt',now(),
    'models',coalesce((select jsonb_agg(jsonb_build_object('key',r.model_key,'name',r.display_name,'category',r.category,'registryStatus',r.status,'version',v.version,'provider',v.provider,'versionStatus',v.status,'releasedAt',v.released_at,'metrics',v.metrics) order by r.category,r.model_key) from public.nia_model_registry r left join lateral(select mv.* from public.nia_model_versions mv where mv.registry_id=r.id order by case mv.status when 'active' then 0 when 'candidate' then 1 else 2 end,mv.released_at desc limit 1)v on true),'[]'::jsonb),
    'datasets',coalesce((select jsonb_agg(row_to_json(x)) from(select d.dataset_key "datasetKey",d.version,d.schema_version "schemaVersion",d.row_count "rowCount",d.window_days "windowDays",d.content_hash "contentHash",d.created_at "createdAt" from public.nia_dataset_versions d where d.tenant_id=target_tenant_id and d.business_id=target_business_id and(d.branch_id=target_branch_id or d.branch_id is null) order by d.created_at desc limit 12)x),'[]'::jsonb),
    'drift',coalesce((select jsonb_agg(row_to_json(x)) from(select d.metric_name "metricName",d.metric_value "metricValue",d.threshold,d.status,d.measured_at "measuredAt" from public.nia_drift_measurements d where d.tenant_id=target_tenant_id and d.business_id=target_business_id and(d.branch_id=target_branch_id or d.branch_id is null) order by d.measured_at desc limit 20)x),'[]'::jsonb),
    'evaluations',coalesce((select jsonb_agg(row_to_json(x)) from(select r.suite,r.provider,r.model,r.status,r.passed_cases "passedCases",r.total_cases "totalCases",r.grounding_score "groundingScore",r.regression_score "regressionScore",r.started_at "startedAt",r.completed_at "completedAt" from public.nia_evaluation_runs r order by r.started_at desc limit 12)x),'[]'::jsonb),
    'calibration',(select jsonb_build_object('version',c.version,'category',c.merchant_category,'sampleSize',c.sample_size,'thresholds',c.thresholds,'calibratedAt',c.calibrated_at) from public.nia_anomaly_calibrations c where c.tenant_id=target_tenant_id and c.business_id=target_business_id and c.active order by c.version desc limit 1),
    'jobs',coalesce((select jsonb_agg(row_to_json(x)) from(select j.id,j.job_name "jobName",j.status,j.trigger_source "triggerSource",j.trace_id "traceId",j.duration_ms "durationMs",j.processed_count "processedCount",j.succeeded_count "succeededCount",j.failed_count "failedCount",j.error_code "errorCode",j.started_at "startedAt",j.completed_at "completedAt" from public.observability_job_runs j where(j.tenant_id=target_tenant_id and(j.business_id=target_business_id or j.business_id is null))or(j.tenant_id is null and j.job_name like 'nia.%') order by j.started_at desc limit 20)x),'[]'::jsonb)
  );
end $$;
revoke all on function public.get_nia_governance_dashboard(uuid,uuid,uuid) from public,anon;
grant execute on function public.get_nia_governance_dashboard(uuid,uuid,uuid) to authenticated;

comment on table public.observability_job_runs is 'Durable job lifecycle, counters, errors, and W3C trace roots for operational observability.';
comment on table public.observability_spans is 'W3C-compatible server/client spans correlated by trace_id.';
commit;
