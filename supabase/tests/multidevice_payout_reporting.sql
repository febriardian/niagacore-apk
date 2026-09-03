begin;

select plan(14);

select has_column('public','journal_entries','branch_id','journal entries carry branch scope');
select has_trigger('public','journal_entries','journal_entries_set_branch','journal branch is resolved automatically');
select has_function('public','admin_verify_withdrawal_account',array['uuid','text','text'],'account verification RPC exists');
select has_function('public','list_manual_payout_queue',array[]::text[],'manual payout queue RPC exists');
select has_function('public','admin_review_withdrawal',array['uuid','text','text','text','text','boolean'],'MFA maker-checker payout RPC exists');
select has_column('public','withdrawal_requests','transfer_evidence_path','payout stores evidence path');
select has_column('public','withdrawal_requests','paid_at','payout stores payment timestamp');
select has_column('public','withdrawal_accounts','verified_by','account verification is attributable');

insert into auth.users(id,aud,role,email)
values('10000000-0000-0000-0000-000000000001','authenticated','authenticated','multi-device@niagacore.test');
insert into public.tenants(id,name,slug,created_by)
values('20000000-0000-0000-0000-000000000001','Tenant Perangkat','tenant-perangkat','10000000-0000-0000-0000-000000000001');
insert into public.businesses(id,tenant_id,name)
values('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Usaha Perangkat');
insert into public.branches(id,tenant_id,business_id,name,code)
values('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Cabang Uji','UJI01');
insert into public.devices(id,tenant_id,branch_id,label,status) values
('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','HP Uji Satu','active'),
('50000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','HP Uji Dua','active');
insert into public.shifts(id,tenant_id,branch_id,device_id,user_id,opening_minor,status,opened_at) values
('60000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',0,'open',now()),
('60000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',0,'open',now());

select is((select count(*)::integer from public.devices where tenant_id='20000000-0000-0000-0000-000000000001'),2,'one account can own two active devices');
select is((select count(*)::integer from public.shifts where user_id='10000000-0000-0000-0000-000000000001' and status='open'),2,'same account can open independent shifts on two devices');
select throws_ok(
  $$insert into public.shifts(id,tenant_id,branch_id,device_id,user_id,opening_minor,status,opened_at) values('60000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',0,'open',now())$$,
  '23505',null,'duplicate open shift is rejected only for the same user-device-branch tuple'
);
update public.devices set status='revoked' where id='50000000-0000-0000-0000-000000000001';
select is((select status::text from public.devices where id='50000000-0000-0000-0000-000000000001'),'revoked','selected device is revoked');
select is((select status::text from public.devices where id='50000000-0000-0000-0000-000000000002'),'active','other device session remains active');
select results_eq(
  $$select indexdef like '%(device_id, user_id, branch_id)%' from pg_indexes where schemaname='public' and indexname='one_open_shift_per_user_device_branch'$$,
  $$values(true)$$,
  'open shift uniqueness uses device, user, and branch'
);

select * from finish();
rollback;
