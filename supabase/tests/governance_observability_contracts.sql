begin;

select plan(12);

select has_table('public','observability_job_runs','job observability table exists');
select has_column('public','observability_job_runs','trace_id','job has W3C trace id');
select has_column('public','observability_job_runs','status','job has truthful lifecycle status');
select has_column('public','observability_job_runs','duration_ms','job duration is measured');
select has_column('public','observability_job_runs','processed_count','job processed counter exists');
select has_table('public','observability_spans','distributed spans table exists');
select has_column('public','observability_spans','parent_span_id','span parent is recorded');
select has_column('public','observability_spans','duration_ms','span duration is measured');
select has_function('public','get_nia_governance_dashboard',array['uuid','uuid','uuid'],'governance dashboard RPC exists');
select has_table('public','nia_model_versions','model versions are governed');
select has_table('public','nia_dataset_versions','dataset fingerprints are governed');
select has_table('public','nia_evaluation_runs','evaluation history is governed');

select * from finish();
rollback;
