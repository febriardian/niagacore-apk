begin;

select plan(10);

select has_table('public','qris_recovery_events','QRIS recovery audit table exists');
select has_column('public','qris_recovery_events','outcome','recovery outcome is recorded');
select has_column('public','qris_recovery_events','device_id','recovery is device scoped');
select has_function('public','recover_qris_payment_session',array['uuid','uuid'],'server QRIS recovery RPC exists');
select has_function('public','expire_stale_qris_payments',array['uuid','uuid'],'stale QRIS expiry RPC exists');
select has_function('public','get_operational_health',array['uuid','uuid','uuid'],'operational health RPC exists');
select has_table('public','nia_model_registry','NIA model registry exists');
select has_table('public','nia_dataset_versions','NIA dataset versions exist');
select has_table('public','nia_drift_measurements','NIA drift measurements exist');
select has_table('public','nia_evaluation_runs','NIA evaluation runs exist');
select has_table('public','nia_anomaly_calibrations','NIA anomaly calibration exists');

select * from finish();
rollback;
