begin;

-- Registry and version history make every analytical result reproducible.
create table if not exists public.nia_model_registry (
  id uuid primary key default gen_random_uuid(),
  model_key text not null unique check (model_key ~ '^[a-z][a-z0-9_]{2,79}$'),
  display_name text not null,
  category text not null check (category in ('forecast','anomaly','customer','retrieval','explainer')),
  status text not null default 'active' check (status in ('active','shadow','retired')),
  owner text not null default 'niagacore',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nia_model_versions (
  id uuid primary key default gen_random_uuid(),
  registry_id uuid not null references public.nia_model_registry(id) on delete cascade,
  version text not null check (version ~ '^[0-9]+[.][0-9]+[.][0-9]+$'),
  provider text not null,
  artifact_ref text,
  parameters jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','candidate','retired')),
  released_at timestamptz not null default now(),
  unique (registry_id,version)
);

create table if not exists public.nia_dataset_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null,
  branch_id uuid,
  dataset_key text not null check (dataset_key ~ '^[a-z][a-z0-9_]{2,79}$'),
  version text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  schema_version text not null,
  row_count integer not null default 0 check (row_count >= 0),
  window_days integer not null check (window_days between 1 and 365),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id,business_id) references public.businesses(tenant_id,id) on delete cascade,
  foreign key (tenant_id,branch_id) references public.branches(tenant_id,id) on delete cascade,
  unique (tenant_id,business_id,branch_id,dataset_key,content_hash)
);

create table if not exists public.nia_anomaly_calibrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null,
  merchant_category text not null default 'general',
  version integer not null default 1 check (version > 0),
  thresholds jsonb not null,
  sample_size integer not null default 0 check (sample_size >= 0),
  active boolean not null default true,
  calibrated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  foreign key (tenant_id,business_id) references public.businesses(tenant_id,id) on delete cascade,
  unique (tenant_id,business_id,version),
  check (jsonb_typeof(thresholds)='object')
);

create unique index if not exists nia_anomaly_one_active_idx
  on public.nia_anomaly_calibrations(tenant_id,business_id) where active;

create table if not exists public.nia_drift_measurements (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  business_id uuid not null,
  branch_id uuid,
  model_version_id uuid references public.nia_model_versions(id),
  dataset_version_id uuid references public.nia_dataset_versions(id) on delete set null,
  metric_name text not null,
  metric_value numeric not null,
  threshold numeric not null check (threshold >= 0),
  status text not null check (status in ('stable','warning','drift')),
  baseline jsonb not null default '{}'::jsonb,
  observed jsonb not null default '{}'::jsonb,
  measured_at timestamptz not null default now(),
  foreign key (tenant_id,business_id) references public.businesses(tenant_id,id) on delete cascade,
  foreign key (tenant_id,branch_id) references public.branches(tenant_id,id) on delete cascade
);

-- Evaluation data is intentionally separated from production prompts.
create table if not exists public.nia_evaluation_cases (
  id uuid primary key default gen_random_uuid(),
  suite text not null,
  locale text not null default 'id-ID',
  question text not null check (char_length(trim(question)) between 4 and 500),
  expected_intent text not null,
  reference_answer text not null check (char_length(trim(reference_answer)) between 10 and 2000),
  required_facts jsonb not null default '[]'::jsonb,
  forbidden_claims jsonb not null default '[]'::jsonb,
  source_ids text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  check (jsonb_typeof(required_facts)='array'),
  check (jsonb_typeof(forbidden_claims)='array')
);

create table if not exists public.nia_evaluation_schedules (
  id uuid primary key default gen_random_uuid(),
  suite text not null unique,
  provider_order text[] not null default array['gemini','cloudflare'],
  interval_hours integer not null default 24 check (interval_hours between 1 and 720),
  active boolean not null default true,
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.nia_evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid references public.nia_evaluation_schedules(id) on delete set null,
  suite text not null,
  provider text not null,
  model text not null,
  status text not null default 'running' check (status in ('running','passed','failed','partial')),
  total_cases integer not null default 0,
  passed_cases integer not null default 0,
  grounding_score numeric,
  regression_score numeric,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.nia_evaluation_results (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.nia_evaluation_runs(id) on delete cascade,
  case_id uuid not null references public.nia_evaluation_cases(id) on delete cascade,
  passed boolean not null,
  intent_match boolean not null,
  grounding_score numeric not null check (grounding_score between 0 and 1),
  reference_score numeric not null check (reference_score between 0 and 1),
  forbidden_claims_found text[] not null default '{}',
  answer text not null,
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id,case_id)
);

create index if not exists nia_dataset_scope_idx on public.nia_dataset_versions(tenant_id,business_id,branch_id,created_at desc);
create index if not exists nia_drift_scope_idx on public.nia_drift_measurements(tenant_id,business_id,branch_id,measured_at desc);
create index if not exists nia_eval_run_time_idx on public.nia_evaluation_runs(started_at desc);

alter table public.nia_model_registry enable row level security;
alter table public.nia_model_versions enable row level security;
alter table public.nia_dataset_versions enable row level security;
alter table public.nia_anomaly_calibrations enable row level security;
alter table public.nia_drift_measurements enable row level security;
alter table public.nia_evaluation_cases enable row level security;
alter table public.nia_evaluation_schedules enable row level security;
alter table public.nia_evaluation_runs enable row level security;
alter table public.nia_evaluation_results enable row level security;

create policy nia_registry_read on public.nia_model_registry for select to authenticated using (true);
create policy nia_model_versions_read on public.nia_model_versions for select to authenticated using (true);
create policy nia_dataset_member_read on public.nia_dataset_versions for select to authenticated using (private.is_tenant_member(tenant_id));
create policy nia_calibration_member_read on public.nia_anomaly_calibrations for select to authenticated using (private.is_tenant_member(tenant_id));
create policy nia_drift_member_read on public.nia_drift_measurements for select to authenticated using (private.is_tenant_member(tenant_id));

insert into public.nia_model_registry(model_key,display_name,category,metadata) values
  ('demand_forecast','Statistical demand forecast','forecast','{"methods":["moving_average","exponential_smoothing","croston"]}'::jsonb),
  ('operational_anomaly','Operational anomaly detector','anomaly','{"methods":["rules","robust_mad"]}'::jsonb),
  ('customer_rfm','Customer RFM segmentation','customer','{"method":"deterministic_rfm"}'::jsonb),
  ('hybrid_retrieval','Hybrid knowledge retrieval','retrieval','{"methods":["keyword","embedding"]}'::jsonb),
  ('nia_explainer','Grounded NIA explainer','explainer','{"providers":["gemini","cloudflare"]}'::jsonb)
on conflict(model_key) do update set display_name=excluded.display_name,category=excluded.category,metadata=excluded.metadata,updated_at=now();

insert into public.nia_model_versions(registry_id,version,provider,parameters,status)
select id,'1.0.0',case when model_key='nia_explainer' then 'gemini+cloudflare' else 'niagacore' end,
  case model_key
    when 'operational_anomaly' then '{"refundRatio":0.10,"discountRatio":0.20,"robustMad":3.5}'::jsonb
    when 'demand_forecast' then '{"ewmaAlpha":0.35,"crostonAlpha":0.20,"predictionInterval":0.90}'::jsonb
    else '{}'::jsonb end,'active'
from public.nia_model_registry
on conflict(registry_id,version) do update set parameters=excluded.parameters,status='active';

insert into public.nia_evaluation_cases(suite,question,expected_intent,reference_answer,required_facts,forbidden_claims,source_ids,metadata) values
  ('nia_core_v1','Bagaimana cara retur transaksi?','ask','Buka Riwayat transaksi, pilih transaksi selesai, lalu ajukan retur sesuai kewenangan.', '["Riwayat transaksi","retur"]','["retur selalu otomatis disetujui"]',array['K_SYS_1'],'{"provenance":"reported_user_question"}'),
  ('nia_core_v1','Barang apa yang perlu diperbanyak?','forecast','Pesanan ulang hanya disarankan untuk produk dengan data cukup dan stok di bawah titik pemesanan ulang.', '["data cukup","titik pemesanan ulang"]','["semua stok harus ditambah"]','{}','{"provenance":"reported_user_question"}'),
  ('nia_core_v1','Apakah ada transaksi tidak biasa?','anomaly','Tampilkan hanya sinyal yang melewati ambang merchant dan sertakan bukti yang dapat diperiksa.', '["ambang","bukti"]','["pasti terjadi kecurangan"]','{}','{"provenance":"representative_case"}'),
  ('nia_core_v1','Siapa pelanggan yang perlu promosi?','customers','Gunakan segmen RFM untuk kelompok pelanggan dan kirim promosi hanya kepada pelanggan yang menyetujui.', '["RFM","persetujuan"]','["sifat pribadi pelanggan"]','{}','{"provenance":"representative_case"}')
on conflict do nothing;

insert into public.nia_evaluation_schedules(suite,provider_order,interval_hours)
values('nia_core_v1',array['gemini','cloudflare'],24)
on conflict(suite) do update set active=true,provider_order=excluded.provider_order,interval_hours=excluded.interval_hours;

create or replace function public.get_nia_runtime_governance(
  target_tenant_id uuid,
  target_business_id uuid
)
returns jsonb language sql stable security definer set search_path='' as $$
  select case when not private.is_tenant_member(target_tenant_id) then null else jsonb_build_object(
    'models',coalesce((
      select jsonb_object_agg(r.model_key,jsonb_build_object('versionId',v.id,'version',v.version,'provider',v.provider,'parameters',v.parameters))
      from public.nia_model_registry r
      join lateral (
        select mv.id,mv.version,mv.provider,mv.parameters from public.nia_model_versions mv
        where mv.registry_id=r.id and mv.status='active' order by mv.released_at desc limit 1
      ) v on true where r.status='active'
    ),'{}'::jsonb),
    'anomalyCalibration',coalesce((
      select c.thresholds || jsonb_build_object('version',c.version,'merchantCategory',c.merchant_category,'sampleSize',c.sample_size)
      from public.nia_anomaly_calibrations c
      where c.tenant_id=target_tenant_id and c.business_id=target_business_id and c.active
      order by c.version desc limit 1
    ),'{"refundRatio":0.10,"discountRatio":0.20,"robustMad":3.5,"cashVarianceMinor":0,"version":0,"merchantCategory":"general","sampleSize":0}'::jsonb)
  ) end;
$$;

create or replace function public.get_nia_anomaly_observations(
  target_tenant_id uuid,
  target_business_id uuid,
  target_branch_id uuid,
  target_window_days integer default 90
)
returns jsonb language sql stable security definer set search_path='' as $$
  with calibration as (
    select coalesce((
      select (c.thresholds->>'discountRatio')::numeric
      from public.nia_anomaly_calibrations c
      where c.tenant_id=target_tenant_id and c.business_id=target_business_id and c.active
      order by c.version desc limit 1
    ),.20::numeric) discount_ratio
  ), scoped_sales as (
    select s.subtotal_minor,s.discount_minor
    from public.sales s
    where s.tenant_id=target_tenant_id and s.business_id=target_business_id
      and s.branch_id=target_branch_id and s.status='paid'
      and s.occurred_at>=now()-(greatest(7,least(coalesce(target_window_days,90),365))*interval '1 day')
  )
  select case when not private.can_access_branch(target_tenant_id,target_branch_id) then null else jsonb_build_object(
    'discountRatioThreshold',(select discount_ratio from calibration),
    'highDiscountTransactions',(select count(*) from scoped_sales,calibration where subtotal_minor>0 and discount_minor::numeric/subtotal_minor>discount_ratio)
  ) end;
$$;

create or replace function public.calibrate_nia_anomaly_thresholds(
  target_tenant_id uuid,
  target_business_id uuid,
  lookback_days integer default 90
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  actor_role public.membership_role;
  category_name text;
  sample_count integer;
  discount_limit numeric;
  refund_limit numeric;
  cash_limit numeric;
  next_version integer;
  calibration_id uuid;
begin
  actor_role:=private.current_role(target_tenant_id);
  if (select auth.role())<>'service_role' and (actor_role is null or actor_role not in ('owner','business_manager')) then
    raise exception 'calibration_access_denied';
  end if;
  if not exists(select 1 from public.businesses b where b.tenant_id=target_tenant_id and b.id=target_business_id) then
    raise exception 'business_not_found';
  end if;
  select coalesce(b.modules[1],'general') into category_name from public.businesses b where b.tenant_id=target_tenant_id and b.id=target_business_id;
  select count(*)::integer,
    coalesce(percentile_cont(.95) within group(order by case when s.subtotal_minor>0 then s.discount_minor::numeric/s.subtotal_minor else 0 end),.20)
  into sample_count,discount_limit
  from public.sales s where s.tenant_id=target_tenant_id and s.business_id=target_business_id and s.status='paid'
    and s.occurred_at>=now()-(greatest(30,least(coalesce(lookback_days,90),365))*interval '1 day');
  with sale_totals as (
    select coalesce(sum(s.total_minor),0)::numeric total_minor
    from public.sales s
    where s.tenant_id=target_tenant_id and s.business_id=target_business_id and s.status='paid'
      and s.occurred_at>=now()-(greatest(30,least(coalesce(lookback_days,90),365))*interval '1 day')
  ), refund_totals as (
    select coalesce(sum(r.amount_minor),0)::numeric refund_minor
    from public.refunds r
    where r.tenant_id=target_tenant_id and r.business_id=target_business_id and r.status='posted'
      and r.occurred_at>=now()-(greatest(30,least(coalesce(lookback_days,90),365))*interval '1 day')
  )
  select least(.25::numeric,greatest(.05::numeric,coalesce(refund_minor/nullif(total_minor,0),.10::numeric)*1.5))
  into refund_limit from sale_totals cross join refund_totals;
  select coalesce(percentile_cont(.95) within group(order by abs(sh.variance_minor)),0)
  into cash_limit from public.shifts sh join public.branches br on br.tenant_id=sh.tenant_id and br.id=sh.branch_id
  where sh.tenant_id=target_tenant_id and br.business_id=target_business_id and sh.status='closed'
    and sh.closed_at>=now()-(greatest(30,least(coalesce(lookback_days,90),365))*interval '1 day');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_business_id::text,0));
  select coalesce(max(version),0)+1 into next_version from public.nia_anomaly_calibrations where tenant_id=target_tenant_id and business_id=target_business_id;
  update public.nia_anomaly_calibrations set active=false where tenant_id=target_tenant_id and business_id=target_business_id and active;
  insert into public.nia_anomaly_calibrations(tenant_id,business_id,merchant_category,version,thresholds,sample_size,created_by)
  values(target_tenant_id,target_business_id,category_name,next_version,jsonb_build_object(
    'refundRatio',coalesce(refund_limit,.10),'discountRatio',greatest(.10,least(coalesce(discount_limit,.20),.50)),
    'robustMad',case when sample_count>=180 then 3.5 when sample_count>=60 then 4.0 else 4.5 end,
    'cashVarianceMinor',coalesce(cash_limit,0)
  ),sample_count,(select auth.uid())) returning id into calibration_id;
  return calibration_id;
end;
$$;

revoke all on function public.get_nia_runtime_governance(uuid,uuid) from public;
grant execute on function public.get_nia_runtime_governance(uuid,uuid) to authenticated;
revoke all on function public.get_nia_anomaly_observations(uuid,uuid,uuid,integer) from public;
grant execute on function public.get_nia_anomaly_observations(uuid,uuid,uuid,integer) to authenticated;
revoke all on function public.calibrate_nia_anomaly_thresholds(uuid,uuid,integer) from public;
grant execute on function public.calibrate_nia_anomaly_thresholds(uuid,uuid,integer) to authenticated,service_role;

comment on table public.nia_model_registry is 'Registry for deterministic analytics, retrieval, and grounded explanation components.';
comment on table public.nia_dataset_versions is 'Immutable fingerprints of datasets used by NIA outputs.';
comment on table public.nia_drift_measurements is 'Observed drift metrics compared with versioned thresholds.';
comment on table public.nia_evaluation_cases is 'Versioned real-question evaluation set for grounding and provider regression.';
comment on table public.nia_evaluation_schedules is 'Due-state consumed by the nia-evaluator Edge Function; invoke that function from Supabase Cron.';

commit;
