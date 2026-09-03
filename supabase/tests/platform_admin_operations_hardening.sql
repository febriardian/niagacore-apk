begin;

select plan(30);

select has_table('public','gateway_webhook_events','webhook processing has a durable event table');
select has_column('public','payments','reconciliation_status','payment reconciliation status is persisted');
select has_column('public','payments','last_reconciled_by','payment reconciliation records the admin');
select has_column('public','withdrawal_requests','approved_by','payout approval actor is preserved');
select has_column('public','withdrawal_requests','paid_by','payout payment actor is preserved');
select has_column('public','production_gate_evidence','submitted_by','gate submitter is preserved');
select has_column('public','platform_releases','signing_certificate_sha256','release signing certificate is pinned');
select has_column('public','platform_releases','published_by','release publisher is attributable');

select has_function('public','admin_review_withdrawal',array['uuid','text','text','text','text','boolean'],'payout RPC supports audited single-operator confirmation');
select has_function('public','admin_submit_production_gate',array['text','text','text'],'production gate submission RPC exists');
select has_function('public','admin_review_production_gate',array['text','text','text','boolean'],'production gate review RPC exists');
select has_function('public','admin_create_release_draft',array['text','integer','text','jsonb','boolean','text','text','text'],'release draft RPC exists');
select has_function('public','admin_publish_release_draft',array['uuid'],'release publication RPC exists');
select has_function('public','admin_operations_snapshot',array[]::text[],'live admin operations snapshot exists');
select has_function('public','admin_prepare_refund_retry',array['uuid'],'admin refund retry preparation exists');

select is(
  (select has_function_privilege('authenticated','public.release_due_wallet_settlements(integer)','execute')),
  false,
  'authenticated admins cannot invoke scheduled settlement release'
);
select is(
  (select has_function_privilege('authenticated','public.release_due_wallet_reserves(integer)','execute')),
  false,
  'authenticated admins cannot invoke scheduled reserve release'
);
select is(
  (select has_function_privilege('service_role','public.release_due_wallet_settlements(integer)','execute')),
  true,
  'service role retains settlement release access'
);
select is(
  (select has_function_privilege('authenticated','public.record_admin_payment_reconciliation(text,text,text,uuid)','execute')),
  false,
  'client cannot forge payment reconciliation records'
);
select is(
  (select has_function_privilege('authenticated','public.record_gateway_webhook_event(text,text,boolean,text,text,text,jsonb)','execute')),
  false,
  'client cannot forge webhook records'
);

insert into auth.users(id,aud,role,email) values
  ('91000000-0000-0000-0000-000000000001','authenticated','authenticated','super-admin@niagacore.test'),
  ('91000000-0000-0000-0000-000000000002','authenticated','authenticated','finance-admin@niagacore.test'),
  ('91000000-0000-0000-0000-000000000003','authenticated','authenticated','operations-admin@niagacore.test'),
  ('91000000-0000-0000-0000-000000000004','authenticated','authenticated','release-manager@niagacore.test'),
  ('91000000-0000-0000-0000-000000000005','authenticated','authenticated','auditor@niagacore.test');
insert into public.platform_admins(user_id,email,role) values
  ('91000000-0000-0000-0000-000000000001','super-admin@niagacore.test','super_admin'),
  ('91000000-0000-0000-0000-000000000002','finance-admin@niagacore.test','finance_admin'),
  ('91000000-0000-0000-0000-000000000003','operations-admin@niagacore.test','operations_admin'),
  ('91000000-0000-0000-0000-000000000004','release-manager@niagacore.test','release_manager'),
  ('91000000-0000-0000-0000-000000000005','auditor@niagacore.test','auditor');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2"}',true);
select ok(public.admin_has_permission('admin.manage'),'super admin can manage the admin team');
select ok(public.admin_has_permission('payout.pay'),'super admin can pay withdrawals');
select ok(public.admin_has_permission('system.verify'),'super admin can verify a production gate');

select set_config('request.jwt.claims','{"sub":"91000000-0000-0000-0000-000000000002","role":"authenticated","aal":"aal2"}',true);
select ok(public.admin_has_permission('payment.reconcile'),'finance admin can reconcile payments');
select ok(not public.admin_has_permission('release.publish'),'finance admin cannot publish releases');

select set_config('request.jwt.claims','{"sub":"91000000-0000-0000-0000-000000000003","role":"authenticated","aal":"aal2"}',true);
select ok(public.admin_has_permission('system.manage'),'operations admin can submit production evidence');
select ok(not public.admin_has_permission('system.verify'),'operations admin cannot verify its production evidence');

select set_config('request.jwt.claims','{"sub":"91000000-0000-0000-0000-000000000004","role":"authenticated","aal":"aal2"}',true);
select ok(public.admin_has_permission('release.publish'),'release manager can publish a gated draft');
select ok(not public.admin_has_permission('payout.pay'),'release manager cannot pay withdrawals');

select set_config('request.jwt.claims','{"sub":"91000000-0000-0000-0000-000000000005","role":"authenticated","aal":"aal2"}',true);
select ok(not public.admin_has_permission('payment.reconcile'),'auditor has no payment mutation permission');

select * from finish();
rollback;
