begin;
select plan(5);
select has_function('public','fail_qris_payment_initialization',array['uuid','text','text','jsonb'],'QRIS initialization failure RPC exists');
select function_privs_are('public','fail_qris_payment_initialization',array['uuid','text','text','jsonb'],'authenticated',array['EXECUTE'],'authenticated can close its failed QRIS initialization');
select has_column('public','payments','provider_status','provider failure status is persisted');
select has_column('public','payments','metadata','safe QRIS diagnostics are persisted');
select has_column('public','sales','status','failed QRIS sale can be voided');
select * from finish();
rollback;
