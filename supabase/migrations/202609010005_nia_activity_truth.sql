begin;

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
    'evaluations',coalesce((select jsonb_agg(row_to_json(x)) from(select r.suite,r.provider,r.model,r.status,r.passed_cases "passedCases",r.total_cases "totalCases",r.grounding_score "groundingScore",r.regression_score "regressionScore",r.metadata,r.started_at "startedAt",r.completed_at "completedAt" from public.nia_evaluation_runs r order by r.started_at desc limit 12)x),'[]'::jsonb),
    'calibration',(select jsonb_build_object('version',c.version,'category',c.merchant_category,'sampleSize',c.sample_size,'thresholds',c.thresholds,'calibratedAt',c.calibrated_at) from public.nia_anomaly_calibrations c where c.tenant_id=target_tenant_id and c.business_id=target_business_id and c.active order by c.version desc limit 1),
    'jobs',coalesce((select jsonb_agg(row_to_json(x)) from(select j.id,j.job_name "jobName",j.status,j.trigger_source "triggerSource",j.trace_id "traceId",j.duration_ms "durationMs",j.processed_count "processedCount",j.succeeded_count "succeededCount",j.failed_count "failedCount",j.error_code "errorCode",j.started_at "startedAt",j.completed_at "completedAt" from public.observability_job_runs j where(j.tenant_id=target_tenant_id and(j.business_id=target_business_id or j.business_id is null))or(j.tenant_id is null and j.job_name like 'nia.%') order by j.started_at desc limit 20)x),'[]'::jsonb)
  );
end $$;

revoke all on function public.get_nia_governance_dashboard(uuid,uuid,uuid) from public,anon;
grant execute on function public.get_nia_governance_dashboard(uuid,uuid,uuid) to authenticated;

comment on function public.get_nia_governance_dashboard(uuid,uuid,uuid) is 'Owner dashboard with truthful dataset history, provider diagnostics, calibration readiness, and observed jobs.';
commit;
