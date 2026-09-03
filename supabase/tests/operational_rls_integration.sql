-- Integration gate for the operational paths used by the mobile application.
-- Run in a fresh local Supabase stack with: supabase test db
begin;

select plan(24);

select has_function('public','create_business_branch',array['uuid','text','text'],'branch creation is explicitly business scoped');
select has_function('public','create_credit_sale',array['uuid','uuid','uuid','uuid','uuid','text','jsonb','bigint','date'],'credit POS RPC exists');
select has_function('public','settle_customer_receivable',array['uuid','uuid','uuid','bigint'],'installment RPC exists');
select has_function('public','revoke_registered_device',array['uuid'],'device revocation RPC exists');
select has_function('private','can_access_branch',array['uuid','uuid'],'branch authorization helper exists');
select has_policy('public','sales','sales_select_branch','POS history is branch scoped');
select has_policy('public','payments','payments_select_branch','payments follow sale branch scope');
select has_policy('public','shifts','shifts_select_branch','shifts are branch scoped');
select has_policy('public','refunds','refunds_select_branch','refunds are branch scoped');
select has_policy('public','sale_drafts','sale_drafts_read','server drafts use RLS');
select has_policy('public','devices','devices_select_scoped','device list is scoped');
select has_trigger('public','sync_mutations','sync_mutations_enforce_scope','offline writes are authorized server-side');

select results_eq(
  $$select count(*)::bigint from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='create_business_branch'
      and pg_get_function_identity_arguments(p.oid)='target_business_id uuid, target_name text, target_code text'$$,
  $$values(1::bigint)$$,
  'only the safe multi-business branch signature is installed'
);

select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname='public'
    and tablename in ('sales','shifts','refunds') and policyname like '%_select_branch'$$,
  $$values(3::bigint)$$,
  'POS, shift, and refund aggregates all have branch policies'
);

select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname='public' and tablename='sale_drafts'$$,
  $$values(4::bigint)$$,
  'draft cart has read, insert, update, and delete policies'
);

select has_policy('public','subledger_documents','subledger_documents_select_branch','receivables and payables are branch scoped');

-- The remaining checks assert that sensitive functions cannot be called by anon.
select function_privs_are('public','create_business_branch',array['uuid','text','text'],'anon',array[]::text[],'anonymous cannot add a branch');
select function_privs_are('public','revoke_registered_device',array['uuid'],'anon',array[]::text[],'anonymous cannot revoke a device');
select function_privs_are('public','create_credit_sale',array['uuid','uuid','uuid','uuid','uuid','text','jsonb','bigint','date'],'anon',array[]::text[],'anonymous cannot create credit sales');
select function_privs_are('public','settle_customer_receivable',array['uuid','uuid','uuid','bigint'],'anon',array[]::text[],'anonymous cannot post installments');
select table_privs_are('public','sale_drafts','anon',array[]::text[],'anonymous cannot access server drafts');
select table_privs_are('public','devices','anon',array[]::text[],'anonymous cannot list devices');
select table_privs_are('public','shifts','anon',array[]::text[],'anonymous cannot access shifts');
select table_privs_are('public','refunds','anon',array[]::text[],'anonymous cannot access refunds');

select * from finish();
rollback;
