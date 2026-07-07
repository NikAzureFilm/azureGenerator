begin;

create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;

set search_path = public, extensions;

select plan(54);

create temp table admin_adjust_case_results (
  case_name text primary key,
  user_id uuid not null,
  result jsonb not null
) on commit drop;

create temp table admin_adjust_validation_results (
  label text primary key,
  result jsonb not null
) on commit drop;

create temp table admin_adjust_metric_snapshots (
  label text primary key,
  user_id uuid not null,
  overview jsonb not null
) on commit drop;

create temp table admin_adjust_exceptions (
  label text primary key,
  sqlstate text not null,
  message text not null
) on commit drop;

create or replace function pg_temp.create_admin_adjust_user(p_label text)
returns uuid
language plpgsql
as $$
declare
  v_user_id uuid := gen_random_uuid();
  v_email text := lower(regexp_replace(p_label, '[^a-zA-Z0-9]+', '-', 'g'))
    || '-'
    || replace(v_user_id::text, '-', '')
    || '@admin-adjust.local';
begin
  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated',
    'authenticated',
    v_email,
    crypt('password', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

  -- Auth triggers create starter rows; tests seed exact balances themselves.
  delete from public.token_transactions where user_id = v_user_id;
  delete from public.token_balances where user_id = v_user_id;

  return v_user_id;
end;
$$;

-- 1. Credit 100 purchased to a user with no balance rows.
with created_user as (
  select pg_temp.create_admin_adjust_user('case-1-credit-no-balances') as user_id
),
rpc_call as (
  select
    user_id,
    public.admin_adjust_tokens(
      user_id,
      100,
      'purchased'::public.token_source_type,
      'case 1 credit'
    ) as result
  from created_user
)
insert into admin_adjust_case_results (case_name, user_id, result)
select 'case1', user_id, result from rpc_call;

select ok((select (result->>'success')::boolean from admin_adjust_case_results where case_name = 'case1'), 'case 1 returns success true');
select is((select (result->>'applied_amount')::int from admin_adjust_case_results where case_name = 'case1'), 100, 'case 1 returns applied_amount 100');
select is((select count(*)::int from public.token_balances b join admin_adjust_case_results r on r.user_id = b.user_id where r.case_name = 'case1'), 2, 'case 1 creates both balance rows');
select is((select b.balance from public.token_balances b join admin_adjust_case_results r on r.user_id = b.user_id where r.case_name = 'case1' and b.source = 'purchased'), 100, 'case 1 purchased balance is 100');
select is((select b.balance from public.token_balances b join admin_adjust_case_results r on r.user_id = b.user_id where r.case_name = 'case1' and b.source = 'subscription'), 0, 'case 1 subscription balance is 0');
select is((select count(*)::int from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case1'), 1, 'case 1 writes one ledger row');
select is((select t.operation::text from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case1'), 'admin_adjustment', 'case 1 ledger operation is admin_adjustment');
select is((select t.amount from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case1'), 100, 'case 1 ledger amount is 100');
select is((select t.source::text from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case1'), 'purchased', 'case 1 ledger source is purchased');
select is((select t.reference_id from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case1'), 'admin:case 1 credit', 'case 1 ledger reference has admin prefix');
select is((select t.purchased_balance_after from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case1'), 100, 'case 1 ledger purchased snapshot is 100');
select is((select t.subscription_balance_after from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case1'), 0, 'case 1 ledger subscription snapshot is 0');

-- 2. Debit -30 from purchased balance of 100.
with created_user as (
  select pg_temp.create_admin_adjust_user('case-2-debit-partial') as user_id
),
seed_balances as (
  insert into public.token_balances (user_id, source, balance)
  select user_id, source, balance
  from created_user
  cross join (
    values
      ('subscription'::public.token_source_type, 0),
      ('purchased'::public.token_source_type, 100)
  ) seeded(source, balance)
  returning user_id
),
rpc_call as (
  select
    user_id,
    public.admin_adjust_tokens(
      user_id,
      -30,
      'purchased'::public.token_source_type,
      'case 2 debit'
    ) as result
  from (select distinct user_id from seed_balances) seeded_user
)
insert into admin_adjust_case_results (case_name, user_id, result)
select 'case2', user_id, result from rpc_call;

select ok((select (result->>'success')::boolean from admin_adjust_case_results where case_name = 'case2'), 'case 2 returns success true');
select is((select (result->>'applied_amount')::int from admin_adjust_case_results where case_name = 'case2'), -30, 'case 2 returns applied_amount -30');
select is((select b.balance from public.token_balances b join admin_adjust_case_results r on r.user_id = b.user_id where r.case_name = 'case2' and b.source = 'purchased'), 70, 'case 2 purchased balance is 70');
select is((select count(*)::int from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case2'), 1, 'case 2 writes one ledger row');
select is((select t.amount from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case2'), -30, 'case 2 ledger amount is -30');
select is((select t.purchased_balance_after from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case2'), 70, 'case 2 ledger purchased snapshot is 70');

-- 3. Debit -50 from purchased balance of 20 clamps to -20.
with created_user as (
  select pg_temp.create_admin_adjust_user('case-3-debit-clamped') as user_id
),
seed_balances as (
  insert into public.token_balances (user_id, source, balance)
  select user_id, source, balance
  from created_user
  cross join (
    values
      ('subscription'::public.token_source_type, 0),
      ('purchased'::public.token_source_type, 20)
  ) seeded(source, balance)
  returning user_id
),
rpc_call as (
  select
    user_id,
    public.admin_adjust_tokens(
      user_id,
      -50,
      'purchased'::public.token_source_type,
      'case 3 clamp'
    ) as result
  from (select distinct user_id from seed_balances) seeded_user
)
insert into admin_adjust_case_results (case_name, user_id, result)
select 'case3', user_id, result from rpc_call;

select ok((select (result->>'success')::boolean from admin_adjust_case_results where case_name = 'case3'), 'case 3 returns success true');
select is((select (result->>'applied_amount')::int from admin_adjust_case_results where case_name = 'case3'), -20, 'case 3 returns applied_amount -20');
select is((select b.balance from public.token_balances b join admin_adjust_case_results r on r.user_id = b.user_id where r.case_name = 'case3' and b.source = 'purchased'), 0, 'case 3 purchased balance is 0');
select is((select t.amount from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case3'), -20, 'case 3 ledger amount is -20');
select is((select t.purchased_balance_after from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case3'), 0, 'case 3 ledger purchased snapshot is 0');

-- 4. Debit from zero balance fails with no ledger row.
with created_user as (
  select pg_temp.create_admin_adjust_user('case-4-debit-zero') as user_id
),
seed_balances as (
  insert into public.token_balances (user_id, source, balance)
  select user_id, source, balance
  from created_user
  cross join (
    values
      ('subscription'::public.token_source_type, 0),
      ('purchased'::public.token_source_type, 0)
  ) seeded(source, balance)
  returning user_id
),
rpc_call as (
  select
    user_id,
    public.admin_adjust_tokens(
      user_id,
      -10,
      'purchased'::public.token_source_type,
      'case 4 zero'
    ) as result
  from (select distinct user_id from seed_balances) seeded_user
)
insert into admin_adjust_case_results (case_name, user_id, result)
select 'case4', user_id, result from rpc_call;

select ok(not (select (result->>'success')::boolean from admin_adjust_case_results where case_name = 'case4'), 'case 4 returns success false');
select ok((select result->>'error' from admin_adjust_case_results where case_name = 'case4') like '%balance is already 0%', 'case 4 error mentions balance is already 0');
select is((select count(*)::int from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case4'), 0, 'case 4 writes no ledger row');
select is((select b.balance from public.token_balances b join admin_adjust_case_results r on r.user_id = b.user_id where r.case_name = 'case4' and b.source = 'purchased'), 0, 'case 4 purchased balance remains 0');

-- 5. Validation failures do not write ledger rows or change balances.
with created_user as (
  select pg_temp.create_admin_adjust_user('case-5-validation') as user_id
),
seed_balances as (
  insert into public.token_balances (user_id, source, balance)
  select user_id, source, balance
  from created_user
  cross join (
    values
      ('subscription'::public.token_source_type, 5),
      ('purchased'::public.token_source_type, 10)
  ) seeded(source, balance)
  returning user_id
),
validation_calls as (
  select 'amount_zero' as label, public.admin_adjust_tokens(user_id, 0, 'purchased'::public.token_source_type, 'case 5 zero') as result from (select distinct user_id from seed_balances) seeded_user
  union all
  select 'amount_too_large', public.admin_adjust_tokens(user_id, 100001, 'purchased'::public.token_source_type, 'case 5 large') from (select distinct user_id from seed_balances) seeded_user
  union all
  select 'note_null', public.admin_adjust_tokens(user_id, 1, 'purchased'::public.token_source_type, null) from (select distinct user_id from seed_balances) seeded_user
  union all
  select 'note_blank', public.admin_adjust_tokens(user_id, 1, 'purchased'::public.token_source_type, '   ') from (select distinct user_id from seed_balances) seeded_user
),
stored_user as (
  insert into admin_adjust_case_results (case_name, user_id, result)
  select 'case5', user_id, '{"success":true}'::jsonb from (select distinct user_id from seed_balances) seeded_user
  returning user_id
)
insert into admin_adjust_validation_results (label, result)
select label, result from validation_calls;

select ok(not (select (result->>'success')::boolean from admin_adjust_validation_results where label = 'amount_zero'), 'case 5 amount 0 returns success false');
select is((select result->>'error' from admin_adjust_validation_results where label = 'amount_zero'), 'amount must be non-zero', 'case 5 amount 0 error is exact');
select ok(not (select (result->>'success')::boolean from admin_adjust_validation_results where label = 'amount_too_large'), 'case 5 amount 100001 returns success false');
select ok((select result->>'error' from admin_adjust_validation_results where label = 'amount_too_large') like '%out of range%', 'case 5 amount 100001 error mentions out of range');
select ok(not (select (result->>'success')::boolean from admin_adjust_validation_results where label = 'note_null'), 'case 5 null note returns success false');
select is((select result->>'error' from admin_adjust_validation_results where label = 'note_null'), 'note is required', 'case 5 null note error is exact');
select ok(not (select (result->>'success')::boolean from admin_adjust_validation_results where label = 'note_blank'), 'case 5 blank note returns success false');
select is((select result->>'error' from admin_adjust_validation_results where label = 'note_blank'), 'note is required', 'case 5 blank note error is exact');
select is((select count(*)::int from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case5'), 0, 'case 5 validation failures write no ledger rows');
select is((select b.balance from public.token_balances b join admin_adjust_case_results r on r.user_id = b.user_id where r.case_name = 'case5' and b.source = 'purchased'), 10, 'case 5 purchased balance remains unchanged');
select is((select b.balance from public.token_balances b join admin_adjust_case_results r on r.user_id = b.user_id where r.case_name = 'case5' and b.source = 'subscription'), 5, 'case 5 subscription balance remains unchanged');

-- 6. Boundary amounts exactly +/-100000 are accepted.
with created_user as (
  select pg_temp.create_admin_adjust_user('case-6-boundary') as user_id
),
credit_call as (
  select
    user_id,
    public.admin_adjust_tokens(
      user_id,
      100000,
      'purchased'::public.token_source_type,
      'case 6 credit boundary'
    ) as result
  from created_user
),
stored_credit as (
  insert into admin_adjust_case_results (case_name, user_id, result)
  select 'case6_credit', user_id, result from credit_call
  returning user_id
),
debit_call as (
  select
    user_id,
    public.admin_adjust_tokens(
      user_id,
      -100000,
      'purchased'::public.token_source_type,
      'case 6 debit boundary'
    ) as result
  from stored_credit
)
insert into admin_adjust_case_results (case_name, user_id, result)
select 'case6_debit', user_id, result from debit_call;

select ok((select (result->>'success')::boolean from admin_adjust_case_results where case_name = 'case6_credit'), 'case 6 credit 100000 returns success true');
select is((select (result->>'applied_amount')::int from admin_adjust_case_results where case_name = 'case6_credit'), 100000, 'case 6 credit applied_amount is 100000');
select ok((select (result->>'success')::boolean from admin_adjust_case_results where case_name = 'case6_debit'), 'case 6 debit -100000 returns success true');
select is((select (result->>'applied_amount')::int from admin_adjust_case_results where case_name = 'case6_debit'), -100000, 'case 6 debit applied_amount is -100000');
select is((select b.balance from public.token_balances b join admin_adjust_case_results r on r.user_id = b.user_id where r.case_name = 'case6_debit' and b.source = 'purchased'), 0, 'case 6 final purchased balance is 0');
select is((select count(*)::int from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case6_debit'), 2, 'case 6 writes two boundary ledger rows');

-- 7. Ledger balance_after snapshots include both sources.
with created_user as (
  select pg_temp.create_admin_adjust_user('case-7-cross-source-snapshot') as user_id
),
seed_balances as (
  insert into public.token_balances (user_id, source, balance)
  select user_id, source, balance
  from created_user
  cross join (
    values
      ('subscription'::public.token_source_type, 50),
      ('purchased'::public.token_source_type, 10)
  ) seeded(source, balance)
  returning user_id
),
rpc_call as (
  select
    user_id,
    public.admin_adjust_tokens(
      user_id,
      5,
      'purchased'::public.token_source_type,
      'case 7 snapshot'
    ) as result
  from (select distinct user_id from seed_balances) seeded_user
)
insert into admin_adjust_case_results (case_name, user_id, result)
select 'case7', user_id, result from rpc_call;

select ok((select (result->>'success')::boolean from admin_adjust_case_results where case_name = 'case7'), 'case 7 returns success true');
select is((select (result->>'applied_amount')::int from admin_adjust_case_results where case_name = 'case7'), 5, 'case 7 returns applied_amount 5');
select is((select t.subscription_balance_after from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case7'), 50, 'case 7 ledger subscription snapshot is 50');
select is((select t.purchased_balance_after from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case7'), 15, 'case 7 ledger purchased snapshot is 15');

-- 8. Notes are truncated to 200 characters after the admin: prefix.
with created_user as (
  select pg_temp.create_admin_adjust_user('case-8-note-truncation') as user_id
),
rpc_call as (
  select
    user_id,
    public.admin_adjust_tokens(
      user_id,
      1,
      'purchased'::public.token_source_type,
      repeat('x', 250)
    ) as result
  from created_user
)
insert into admin_adjust_case_results (case_name, user_id, result)
select 'case8', user_id, result from rpc_call;

select is((select length(t.reference_id)::int from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case8'), 206, 'case 8 reference_id length is admin prefix plus 200 chars');
select is((select t.reference_id from public.token_transactions t join admin_adjust_case_results r on r.user_id = t.user_id where r.case_name = 'case8'), 'admin:' || repeat('x', 200), 'case 8 reference_id truncates note to first 200 chars');

-- 9. Admin adjustments are excluded from overview consumption and active users.
with created_user as (
  select pg_temp.create_admin_adjust_user('case-9-metrics-exclusion') as user_id
),
seed_balances as (
  insert into public.token_balances (user_id, source, balance)
  select user_id, source, balance
  from created_user
  cross join (
    values
      ('subscription'::public.token_source_type, 0),
      ('purchased'::public.token_source_type, 30)
  ) seeded(source, balance)
  returning user_id
),
before_snapshot as (
  insert into admin_adjust_metric_snapshots (label, user_id, overview)
  select 'before', user_id, public.admin_overview()
  from (select distinct user_id from seed_balances) seeded_user
  returning user_id
),
rpc_call as (
  select
    user_id,
    public.admin_adjust_tokens(
      user_id,
      -10,
      'purchased'::public.token_source_type,
      'case 9 metrics'
    ) as result
  from before_snapshot
),
stored_call as (
  insert into admin_adjust_case_results (case_name, user_id, result)
  select 'case9', user_id, result from rpc_call
  returning user_id
)
insert into admin_adjust_metric_snapshots (label, user_id, overview)
select 'after', user_id, public.admin_overview()
from stored_call;

select is((
  select ((after_snapshot.overview->'tokens'->>'consumed_total')::int - (before_snapshot.overview->'tokens'->>'consumed_total')::int)
  from admin_adjust_metric_snapshots before_snapshot
  join admin_adjust_metric_snapshots after_snapshot on after_snapshot.user_id = before_snapshot.user_id
  where before_snapshot.label = 'before' and after_snapshot.label = 'after'
), 0, 'case 9 admin debit does not change overview consumed_total');
select is((
  select ((after_snapshot.overview->'users'->>'active_30d')::int - (before_snapshot.overview->'users'->>'active_30d')::int)
  from admin_adjust_metric_snapshots before_snapshot
  join admin_adjust_metric_snapshots after_snapshot on after_snapshot.user_id = before_snapshot.user_id
  where before_snapshot.label = 'before' and after_snapshot.label = 'after'
), 0, 'case 9 admin debit does not add active_30d user');

-- 10. Missing auth.users row is rejected by token_balances.user_id FK.
do $$
begin
  perform public.admin_adjust_tokens(
    gen_random_uuid(),
    1,
    'purchased'::public.token_source_type,
    'case 10 missing user'
  );

  insert into admin_adjust_exceptions (label, sqlstate, message)
  values ('case10', '00000', 'no exception');
exception
  when others then
    insert into admin_adjust_exceptions (label, sqlstate, message)
    values ('case10', SQLSTATE, SQLERRM);
end;
$$;

select is((select sqlstate from admin_adjust_exceptions where label = 'case10'), '23503', 'case 10 missing user raises foreign key violation');
select ok((select message from admin_adjust_exceptions where label = 'case10') like '%foreign key%', 'case 10 exception mentions foreign key');

select * from finish();

rollback;
