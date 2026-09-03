-- Release gate for role, tenant and branch isolation. Run with `supabase test db`.
begin;

select plan(21);

select has_table('public','role_permissions','role permission registry exists');
select has_function('private','can_access_branch',array['uuid','uuid'],'branch access helper exists');
select has_function('private','enforce_sync_scope',array[]::text[],'sync authorization trigger exists');
select has_function('public','list_staff_access',array[]::text[],'staff directory RPC exists');
select has_function('public','update_staff_access',array['uuid','membership_role','uuid[]','boolean'],'staff access RPC exists');
select has_function('public','resolve_approval_request',array['uuid','text','text'],'approval RPC exists');
select has_function('public','prepare_approved_midtrans_refund',array['uuid'],'approved QRIS refund RPC exists');
select has_trigger('public','sync_mutations','sync_mutations_enforce_scope','sync writes are protected by a server trigger');
select has_policy('public','branches','branches_select_granted','branch list uses grants');
select has_policy('public','sales','sales_select_branch','sales reads are branch scoped');
select has_policy('public','inventory_movements','inventory_movements_select_branch','inventory reads are branch scoped');
select has_policy('public','approval_requests','approval_requests_select_branch','approval reads are branch scoped');
select has_table('public','inventory_lots','normalized inventory lots exist');
select has_table('public','fixed_assets','normalized fixed assets exist');
select has_table('public','tax_policies','versioned tax policies exist');
select has_table('public','sync_conflict_reviews','server conflict review queue exists');
select has_function('public','run_monthly_depreciation',array['uuid','date'],'monthly depreciation posting exists');
select has_function('public','export_tax_reconciliation',array['uuid','date','date'],'tax reconciliation export exists');

select results_eq(
  $$select enumlabel::text from pg_enum e join pg_type t on t.oid=e.enumtypid
    where t.typnamespace='public'::regnamespace and t.typname='membership_role'
      and enumlabel in ('business_manager','branch_manager','warehouse','purchasing','finance','service_staff','kitchen','waiter','auditor')
    order by enumlabel$$,
  $$values ('auditor'),('branch_manager'),('business_manager'),('finance'),('kitchen'),('purchasing'),('service_staff'),('waiter'),('warehouse')$$,
  'all blueprint staff roles are installed'
);

select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname='public' and tablename in
    ('sales','inventory_movements','purchases','expenses','appointments','dining_tables','business_records','shifts','cash_movements','refunds','approval_requests')
    and policyname like '%_select_branch'$$,
  $$values (11::bigint)$$,
  'every branch-owned aggregate has a branch-select policy'
);

select results_eq(
  $$select count(*)::bigint from public.role_permissions where role in ('owner','business_manager','branch_manager','supervisor','cashier','warehouse','purchasing','finance','auditor','waiter')$$,
  $$values (19::bigint)$$,
  'permission templates are seeded'
);

select * from finish();
rollback;
