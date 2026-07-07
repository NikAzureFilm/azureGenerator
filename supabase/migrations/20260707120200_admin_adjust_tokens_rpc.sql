-- admin_adjust_tokens RPC + consumption-metrics predicate fix.
--
-- Ordered AFTER 20260707120100_token_admin_adjustment_enum.sql (which adds the
-- 'admin_adjustment' enum value this function writes).
--
-- Two things happen here:
--   1. Create public.admin_adjust_tokens — a service-role-only manual credit/
--      debit for a single user's token balance, recorded in token_transactions
--      with operation 'admin_adjustment'.
--   2. Redefine the admin metrics functions so admin adjustments are EXCLUDED
--      from "consumed" token stats (they are manual corrections, not usage).
--      Every consumed-tokens predicate becomes
--        amount < 0 and operation not in ('refund','admin_adjustment')
--      while "refunded" aggregates stay operation = 'refund' only. The canonical
--      definitions live in admin/sql/admin_metrics.sql and
--      admin/sql/admin_explorer.sql, and the dashboard patch copy is
--      admin/sql/patches/2026-07-07-admin-adjust-tokens-2-rpc.sql; the repo keeps
--      them in sync. Re-running is safe.

-- =============================================================================
-- 1. admin_adjust_tokens — manual credit/debit of one user's token balance.
-- =============================================================================
-- p_amount is signed: > 0 credits, < 0 debits. For debits the applied amount is
-- clamped so the balance never drops below 0, and the actually-applied signed
-- amount is what gets recorded and returned. BOTH balance rows are ensured to
-- exist and locked FOR UPDATE in a deterministic order (by source, mirroring
-- deduct_tokens/refund_tokens), so concurrent adjustments serialize without
-- deadlock; the balance_after snapshots are computed from the locked values
-- plus the applied delta (no second unlocked read).
create or replace function public.admin_adjust_tokens(
  p_user_id uuid,
  p_amount  integer,
  p_source  public.token_source_type,
  p_note    text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applied       integer;
  v_sub_balance   integer := 0;
  v_pur_balance   integer := 0;
  v_target        integer;
begin
  -- Validate amount.
  if p_amount is null or p_amount = 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be non-zero');
  end if;
  if abs(p_amount) > 100000 then
    return jsonb_build_object('success', false, 'error', 'amount out of range (max 100000)');
  end if;

  -- Validate note.
  if p_note is null or btrim(p_note) = '' then
    return jsonb_build_object('success', false, 'error', 'note is required');
  end if;

  -- Ensure BOTH balance rows exist so they can both be locked.
  insert into public.token_balances (user_id, source, balance)
  values
    (p_user_id, 'subscription'::public.token_source_type, 0),
    (p_user_id, 'purchased'::public.token_source_type, 0)
  on conflict (user_id, source) do nothing;

  -- Lock both rows in a deterministic order (by source) to avoid deadlocks,
  -- reading both current balances in the same pass.
  select
    coalesce(sum(case when source = 'subscription' then balance else 0 end), 0),
    coalesce(sum(case when source = 'purchased' then balance else 0 end), 0)
    into v_sub_balance, v_pur_balance
  from (
    select source, balance
      from public.token_balances
     where user_id = p_user_id
       and source in ('subscription'::public.token_source_type,
                      'purchased'::public.token_source_type)
     order by source
     for update
  ) locked;

  v_target := case p_source
    when 'subscription' then v_sub_balance
    else v_pur_balance
  end;

  -- For debits, clamp so the balance never goes below zero.
  if p_amount < 0 then
    v_applied := -least(-p_amount, v_target);
  else
    v_applied := p_amount;
  end if;

  -- A debit fully clamped to zero is a no-op: reject rather than silently
  -- succeed, and write no ledger row.
  if v_applied = 0 then
    return jsonb_build_object(
      'success', false,
      'error', 'balance is already 0 — nothing to debit'
    );
  end if;

  update public.token_balances
     set balance = balance + v_applied, updated_at = now()
   where user_id = p_user_id and source = p_source;

  -- balance_after snapshots from the locked values plus the applied delta.
  if p_source = 'subscription' then
    v_sub_balance := v_sub_balance + v_applied;
  else
    v_pur_balance := v_pur_balance + v_applied;
  end if;

  insert into public.token_transactions (
    user_id, operation, amount, source, reference_id,
    subscription_balance_after, purchased_balance_after
  ) values (
    p_user_id,
    'admin_adjustment'::public.token_operation_type,
    v_applied,
    p_source,
    'admin:' || left(p_note, 200),
    v_sub_balance,
    v_pur_balance
  );

  return jsonb_build_object(
    'success', true,
    'applied_amount', v_applied,
    'balance_subscription', v_sub_balance,
    'balance_purchased', v_pur_balance
  );
end;
$$;

revoke all on function public.admin_adjust_tokens(uuid, integer, public.token_source_type, text) from public, anon, authenticated;
grant execute on function public.admin_adjust_tokens(uuid, integer, public.token_source_type, text) to service_role;

-- =============================================================================
-- 2. Consumption-metrics predicate fix — exclude 'admin_adjustment' from
-- "consumed" token aggregates (they are manual corrections, not usage).
-- These redefinitions are copied verbatim from admin/sql/admin_metrics.sql and
-- admin/sql/admin_explorer.sql (the canonical sources). "refunded" aggregates
-- keep operation = 'refund' only.
-- =============================================================================

-- --- admin_overview (admin_metrics.sql) --------------------------------------
create or replace function public.admin_overview()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'users', jsonb_build_object(
      'total',      (select count(*) from profiles),
      'new_7d',     (select count(*) from profiles where created_at >= now() - interval '7 days'),
      'new_30d',    (select count(*) from profiles where created_at >= now() - interval '30 days'),
      'active_30d', (select count(distinct user_id) from token_transactions
                       where created_at >= now() - interval '30 days' and amount < 0
                         and operation <> 'admin_adjustment'),
      'paying',     (select count(*) from subscriptions where status in ('active','trialing'))
    ),
    'generations', jsonb_build_object(
      'cad_jobs',          (select count(*) from cad_jobs),
      'cad_jobs_30d',      (select count(*) from cad_jobs where created_at >= now() - interval '30 days'),
      'cad_jobs_success',  (select count(*) from cad_jobs where status = 'success'),
      'cad_jobs_failure',  (select count(*) from cad_jobs where status = 'failure'),
      'meshes',            (select count(*) from meshes),
      'meshes_30d',        (select count(*) from meshes where created_at >= now() - interval '30 days'),
      'meshes_failure',    (select count(*) from meshes where status = 'failure'),
      'images',            (select count(*) from images),
      'conversations',     (select count(*) from conversations),
      'messages',          (select count(*) from messages),
      'prompts',           (select count(*) from prompts)
    ),
    'tokens', jsonb_build_object(
      'consumed_total', (select coalesce(sum(-amount),0) from token_transactions
                           where amount < 0 and operation not in ('refund','admin_adjustment')),
      'consumed_30d',   (select coalesce(sum(-amount),0) from token_transactions
                           where amount < 0 and operation not in ('refund','admin_adjustment')
                             and created_at >= now() - interval '30 days'),
      'by_operation',   (select coalesce(jsonb_object_agg(operation, total), '{}'::jsonb)
                           from (select operation, sum(-amount) as total
                                   from token_transactions
                                  where amount < 0 and operation not in ('refund','admin_adjustment')
                                  group by operation) t),
      'refunded',             (select coalesce(sum(amount),0) from token_transactions where operation = 'refund'),
      'balance_subscription', (select coalesce(sum(balance),0) from token_balances where source = 'subscription'),
      'balance_purchased',    (select coalesce(sum(balance),0) from token_balances where source = 'purchased'),
      -- tokens credited via paid token-pack purchases (credit_purchased_tokens)
      'purchased_credited',   (select coalesce(sum(amount),0) from token_transactions
                                 where source = 'purchased' and operation = 'chat' and amount > 0)
    ),
    'revenue', jsonb_build_object(
      'mrr_cents', (
        select coalesce(sum(case level
                              when 'pro' then 15000
                              when 'standard' then 3000
                              when 'max' then 150000
                              else 0 end), 0)
          from subscriptions where status in ('active','trialing')
      ),
      'by_plan', (
        select coalesce(jsonb_object_agg(level, cnt), '{}'::jsonb)
          from (select level, count(*) as cnt
                  from subscriptions where status in ('active','trialing')
                 group by level) s
      ),
      'token_pack_revenue_cents', (
        select coalesce(sum(p.price_cents), 0)
          from token_transactions tt
          join token_pack_products p on p.token_amount = tt.amount
         where tt.source = 'purchased' and tt.operation = 'chat' and tt.amount > 0
      ),
      'token_pack_revenue_30d_cents', (
        select coalesce(sum(p.price_cents), 0)
          from token_transactions tt
          join token_pack_products p on p.token_amount = tt.amount
         where tt.source = 'purchased' and tt.operation = 'chat' and tt.amount > 0
           and tt.created_at >= now() - interval '30 days'
      )
    ),
    'storage', jsonb_build_object(
      'generated_asset_bytes', (select coalesce(sum(storage_bytes), 0) from generation_asset_usage),
      'generated_asset_count', (select coalesce(sum(asset_count), 0) from generation_asset_usage),
      'r2_asset_bytes', (select coalesce(sum(r2_storage_bytes), 0) from generation_asset_usage),
      'supabase_asset_bytes', (select coalesce(sum(supabase_storage_bytes), 0) from generation_asset_usage),
      'temp_asset_bytes', (select coalesce(sum(temp_storage_bytes), 0) from generation_asset_usage)
    )
  );
$$;

-- --- admin_daily_activity (admin_metrics.sql) --------------------------------
create or replace function public.admin_daily_activity(days int default 30)
returns table(
  day date,
  signups bigint,
  cad_jobs bigint,
  meshes bigint,
  images bigint,
  tokens_consumed bigint
)
language sql
security definer
set search_path = public
as $$
  with series as (
    select generate_series(current_date - (days - 1), current_date, interval '1 day')::date as day
  )
  select
    s.day,
    (select count(*) from profiles  p where (p.created_at at time zone 'UTC')::date = s.day),
    (select count(*) from cad_jobs  c where (c.created_at at time zone 'UTC')::date = s.day),
    (select count(*) from meshes    m where (m.created_at at time zone 'UTC')::date = s.day),
    (select count(*) from images    i where (i.created_at at time zone 'UTC')::date = s.day),
    (select coalesce(sum(-amount),0) from token_transactions t
       where (t.created_at at time zone 'UTC')::date = s.day
         and t.amount < 0 and t.operation not in ('refund','admin_adjustment'))
  from series s
  order by s.day;
$$;

-- --- admin_top_users (admin_metrics.sql) -------------------------------------
create or replace function public.admin_top_users(p_limit int default 10)
returns table(
  user_id uuid,
  email text,
  full_name text,
  tokens_consumed bigint,
  generations bigint,
  plan text,
  created_at timestamptz
)
language sql
security definer
set search_path = public, auth
as $$
  select
    u.id,
    u.email,
    pr.full_name,
    coalesce((select sum(-amount) from token_transactions t
                where t.user_id = u.id and t.amount < 0 and t.operation not in ('refund','admin_adjustment')), 0) as tokens_consumed,
    coalesce((select count(*) from cad_jobs c where c.user_id = u.id), 0)
      + coalesce((select count(*) from meshes m where m.user_id = u.id), 0) as generations,
    coalesce((select s.level::text from subscriptions s
                where s.user_id = u.id and s.status in ('active','trialing') limit 1), 'free') as plan,
    u.created_at
  from auth.users u
  left join profiles pr on pr.user_id = u.id
  order by tokens_consumed desc
  limit p_limit;
$$;

-- --- admin_user_detail (admin_explorer.sql) ----------------------------------
create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_has_pu boolean := to_regclass('public.provider_usage') is not null;
  v_actual numeric;
  v_result jsonb;
begin
  if v_has_pu then
    execute 'select coalesce(sum(cost_usd),0) from public.provider_usage where user_id = $1'
      into v_actual using p_user_id;
  else
    v_actual := null;
  end if;

  select jsonb_build_object(
    'profile', (
      select jsonb_build_object(
        'user_id',    u.id,
        'email',      u.email,
        'full_name',  pr.full_name,
        'avatar_path', pr.avatar_path,
        'created_at', u.created_at,
        'has_trialed', exists(select 1 from trial_users tu where tu.user_id = u.id)
      )
      from auth.users u
      left join profiles pr on pr.user_id = u.id
      where u.id = p_user_id
    ),
    'subscription', (
      select case when s.id is null then null else jsonb_build_object(
        'level',                  s.level::text,
        'status',                 s.status,
        'stripe_customer_id',     s.stripe_customer_id,
        'stripe_subscription_id', s.stripe_subscription_id,
        'created_at',             s.created_at
      ) end
      from subscriptions s
      where s.user_id = p_user_id
      order by (s.status in ('active','trialing')) desc, s.created_at desc
      limit 1
    ),
    'balances', coalesce((
      select jsonb_object_agg(b.source, jsonb_build_object('balance', b.balance, 'expires_at', b.expires_at))
        from token_balances b
       where b.user_id = p_user_id
    ), '{}'::jsonb),
    'tokens', jsonb_build_object(
      'consumed_total', coalesce((select sum(-amount) from token_transactions
                                    where user_id = p_user_id and amount < 0 and operation not in ('refund','admin_adjustment')), 0),
      'consumed_30d',   coalesce((select sum(-amount) from token_transactions
                                    where user_id = p_user_id and amount < 0 and operation not in ('refund','admin_adjustment')
                                      and created_at >= now() - interval '30 days'), 0),
      'by_operation',   coalesce((
        select jsonb_object_agg(operation, total)
          from (select operation, sum(-amount) as total
                  from token_transactions
                 where user_id = p_user_id and amount < 0 and operation not in ('refund','admin_adjustment')
                 group by operation) t
      ), '{}'::jsonb),
      'refunded',       coalesce((select sum(amount) from token_transactions
                                    where user_id = p_user_id and operation = 'refund'), 0)
    ),
    'generations', jsonb_build_object(
      'cad_jobs',         coalesce((select count(*) from cad_jobs where user_id = p_user_id), 0),
      'cad_jobs_success', coalesce((select count(*) from cad_jobs where user_id = p_user_id and status = 'success'), 0),
      'cad_jobs_failure', coalesce((select count(*) from cad_jobs where user_id = p_user_id and status = 'failure'), 0),
      'meshes',           coalesce((select count(*) from meshes where user_id = p_user_id), 0),
      'meshes_failure',   coalesce((select count(*) from meshes where user_id = p_user_id and status = 'failure'), 0),
      'images',           coalesce((select count(*) from images where user_id = p_user_id), 0),
      'conversations',    coalesce((select count(*) from conversations where user_id = p_user_id), 0)
    ),
    'actual_cost_usd', v_actual,
    'revenue', jsonb_build_object(
      'token_pack_cents', coalesce((
        select sum(p.price_cents)
          from token_transactions tt
          join token_pack_products p on p.token_amount = tt.amount
         where tt.user_id = p_user_id and tt.source = 'purchased'
           and tt.operation = 'chat' and tt.amount > 0
      ), 0),
      'plan_monthly_cents', coalesce((
        select case s.level::text
                 when 'max' then 150000
                 when 'pro' then 15000
                 when 'standard' then 3000
                 else 0 end
          from subscriptions s
         where s.user_id = p_user_id
         order by (s.status in ('active','trialing')) desc, s.created_at desc
         limit 1
      ), 0)
    )
  ) into v_result;

  return v_result;
end;
$$;

-- --- admin_cost_breakdown (admin_explorer.sql) -------------------------------
create or replace function public.admin_cost_breakdown()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_pu       boolean := to_regclass('public.provider_usage') is not null;
  v_cost_total   numeric := 0;
  v_cost_30d     numeric := 0;
  v_by_operation jsonb   := '{}'::jsonb;
  v_by_provider  jsonb   := '{}'::jsonb;
  v_by_model     jsonb   := '{}'::jsonb;
  v_result       jsonb;
begin
  if v_has_pu then
    execute 'select coalesce(sum(cost_usd),0) from public.provider_usage' into v_cost_total;
    execute 'select coalesce(sum(cost_usd),0) from public.provider_usage where created_at >= now() - interval ''30 days''' into v_cost_30d;
    execute $e$
      select coalesce(jsonb_object_agg(operation, total), '{}'::jsonb)
        from (select coalesce(operation,'unknown') as operation, sum(cost_usd) as total
                from public.provider_usage group by 1) t
    $e$ into v_by_operation;
    execute $e$
      select coalesce(jsonb_object_agg(provider, total), '{}'::jsonb)
        from (select coalesce(provider::text,'unknown') as provider, sum(cost_usd) as total
                from public.provider_usage group by 1) t
    $e$ into v_by_provider;
    execute $e$
      select coalesce(jsonb_object_agg(model, total), '{}'::jsonb)
        from (select coalesce(model,'unknown') as model, sum(cost_usd) as total
                from public.provider_usage group by 1) t
    $e$ into v_by_model;
  end if;

  v_result := jsonb_build_object(
    'has_provider_usage', (v_has_pu and v_cost_total > 0),
    'cost_total_usd', v_cost_total,
    'cost_30d_usd',   v_cost_30d,
    'by_operation',   v_by_operation,
    'by_provider',    v_by_provider,
    'by_model',       v_by_model,
    'tokens_by_operation', coalesce((
      select jsonb_object_agg(operation, total)
        from (select operation, sum(-amount) as total
                from token_transactions
               where amount < 0 and operation not in ('refund','admin_adjustment')
               group by operation) t
    ), '{}'::jsonb),
    'revenue', jsonb_build_object(
      'mrr_cents', coalesce((
        select sum(case level when 'max' then 150000 when 'pro' then 15000 when 'standard' then 3000 else 0 end)
          from subscriptions where status in ('active','trialing')
      ), 0),
      'by_plan', coalesce((
        select jsonb_object_agg(level, cnt)
          from (select level::text as level, count(*) as cnt
                  from subscriptions where status in ('active','trialing')
                 group by level) s
      ), '{}'::jsonb),
      'token_pack_cents', coalesce((
        select sum(p.price_cents)
          from token_transactions tt
          join token_pack_products p on p.token_amount = tt.amount
         where tt.source = 'purchased' and tt.operation = 'chat' and tt.amount > 0
      ), 0)
    )
  );

  return v_result;
end;
$$;

-- --- admin_cost_daily (admin_explorer.sql) -----------------------------------
create or replace function public.admin_cost_daily(p_days int default 30)
returns table(
  day             date,
  actual_cost_usd numeric,
  est_cost_usd    numeric,
  token_pack_cents bigint,
  signups         bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_pu boolean := to_regclass('public.provider_usage') is not null;
begin
  return query execute format($q$
    with series as (
      select generate_series(current_date - (%1$s - 1), current_date, interval '1 day')::date as day
    ),
    pu as (
      %2$s
    )
    select
      s.day,
      coalesce((select sum(p.cost_usd) from pu p where p.day = s.day), 0)::numeric as actual_cost_usd,
      coalesce((select sum(-t.amount) from token_transactions t
                  where (t.created_at at time zone 'UTC')::date = s.day
                    and t.amount < 0 and t.operation not in ('refund','admin_adjustment')), 0) * 0.01::numeric as est_cost_usd,
      coalesce((select sum(pp.price_cents) from token_transactions tt
                  join token_pack_products pp on pp.token_amount = tt.amount
                 where (tt.created_at at time zone 'UTC')::date = s.day
                   and tt.source = 'purchased' and tt.operation = 'chat' and tt.amount > 0), 0)::bigint as token_pack_cents,
      coalesce((select count(*) from profiles pr
                  where (pr.created_at at time zone 'UTC')::date = s.day), 0)::bigint as signups
    from series s
    order by s.day
  $q$,
    greatest(coalesce(p_days, 30), 1),
    case when v_has_pu
      then 'select (created_at at time zone ''UTC'')::date as day, cost_usd from public.provider_usage'
      else 'select null::date as day, 0::numeric as cost_usd where false'
    end
  );
end;
$$;

-- --- admin_growth_weekly (admin_explorer.sql) --------------------------------
create or replace function public.admin_growth_weekly(p_weeks int default 12)
returns table(
  week              date,
  signups           bigint,
  active_users      bigint,
  new_subscriptions bigint
)
language sql
security definer
set search_path = public
as $$
  with bounds as (
    select
      date_trunc('week', timezone('UTC', now()))::date as current_week,
      greatest(coalesce(p_weeks, 12), 1) as week_count
  ),
  series as (
    select generate_series(
             (select current_week - ((week_count - 1) * 7) from bounds),
             (select current_week from bounds),
             interval '1 week'
           )::date as week
  )
  select
    s.week,
    coalesce((select count(*) from profiles pr
                where date_trunc('week', pr.created_at at time zone 'UTC')::date = s.week), 0) as signups,
    coalesce((select count(distinct t.user_id) from token_transactions t
                where date_trunc('week', t.created_at at time zone 'UTC')::date = s.week
                  and t.amount < 0 and t.operation not in ('refund','admin_adjustment')), 0) as active_users,
    coalesce((select count(*) from subscriptions sub
                where date_trunc('week', sub.created_at at time zone 'UTC')::date = s.week), 0) as new_subscriptions
  from series s
  order by s.week;
$$;

-- --- admin_retention_cohorts (admin_explorer.sql) ----------------------------
create or replace function public.admin_retention_cohorts(p_weeks int default 12)
returns table(
  cohort_week date,
  cohort_size bigint,
  week_offset int,
  active      bigint
)
language sql
security definer
set search_path = public, auth
as $$
  with bounds as (
    select
      date_trunc('week', timezone('UTC', now()))::date as current_week,
      greatest(coalesce(p_weeks, 12), 1) as week_count
  ),
  cohorts as (
    select
      u.id as user_id,
      date_trunc(
        'week',
        coalesce(pr.created_at, u.created_at) at time zone 'UTC'
      )::date as cohort_week
    from auth.users u
    left join profiles pr on pr.user_id = u.id
    where date_trunc(
            'week',
            coalesce(pr.created_at, u.created_at) at time zone 'UTC'
          )::date >= (select current_week - ((week_count - 1) * 7) from bounds)
  ),
  sizes as (
    select cohort_week, count(*) as cohort_size
      from cohorts
     group by cohort_week
  ),
  offsets as (
    select
      s.cohort_week,
      s.cohort_size,
      generate_series(
        0,
        least(
          (select week_count - 1 from bounds),
          greatest(
            0,
            ((select current_week from bounds) - s.cohort_week) / 7
          )
        )
      )::int as week_offset
    from sizes s
  ),
  activity as (
    select
      c.cohort_week,
      floor(
        (date_trunc('week', t.created_at at time zone 'UTC')::date - c.cohort_week) / 7
      )::int as week_offset,
      count(distinct c.user_id) as active
    from cohorts c
    join token_transactions t
      on t.user_id = c.user_id
     and t.amount < 0
     and t.operation not in ('refund','admin_adjustment')
    where date_trunc('week', t.created_at at time zone 'UTC')::date >= c.cohort_week
    group by c.cohort_week,
             floor((date_trunc('week', t.created_at at time zone 'UTC')::date - c.cohort_week) / 7)::int
  )
  select
    o.cohort_week,
    o.cohort_size,
    o.week_offset,
    coalesce(a.active, 0)::bigint as active
  from offsets o
  left join activity a
    on a.cohort_week = o.cohort_week
   and a.week_offset = o.week_offset
  order by o.cohort_week desc, o.week_offset;
$$;

-- --- admin_users_page (admin_explorer.sql) -----------------------------------
-- Only the tokens_consumed predicate inside the dynamic query changed.
create or replace function public.admin_users_page(
  p_search text default null,
  p_limit  int  default 50,
  p_offset int  default 0,
  p_sort   text default 'last_active',
  p_order  text default 'desc'
)
returns table(
  user_id         uuid,
  email           text,
  full_name       text,
  plan            text,
  sub_status      text,
  created_at      timestamptz,
  last_active     timestamptz,
  generations     bigint,
  tokens_consumed bigint,
  est_cost_usd    numeric,
  actual_cost_usd numeric,
  revenue_cents   bigint,
  total_count     bigint
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_sort_col  text;
  v_order     text;
  v_limit     int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset    int := greatest(coalesce(p_offset, 0), 0);
  v_has_pu    boolean := to_regclass('public.provider_usage') is not null;
  v_actual    text;
  v_sql       text;
begin
  v_sort_col := case lower(coalesce(p_sort, 'last_active'))
    when 'email'           then 'email'
    when 'full_name'       then 'full_name'
    when 'plan'            then 'plan'
    when 'created_at'      then 'created_at'
    when 'last_active'     then 'last_active'
    when 'generations'     then 'generations'
    when 'tokens_consumed' then 'tokens_consumed'
    when 'est_cost_usd'    then 'est_cost_usd'
    when 'actual_cost_usd' then 'actual_cost_usd'
    when 'revenue_cents'   then 'revenue_cents'
    else 'last_active'
  end;

  v_order := case when lower(coalesce(p_order, 'desc')) = 'asc' then 'asc' else 'desc' end;

  if v_has_pu then
    v_actual := '(select coalesce(sum(pu.cost_usd),0) from public.provider_usage pu where pu.user_id = u.id)';
  else
    v_actual := 'null::numeric';
  end if;

  v_sql := format($q$
    with base as (
      select
        u.id as user_id,
        u.email::text as email,
        pr.full_name,
        coalesce(sub.level::text, 'free') as plan,
        sub.status as sub_status,
        u.created_at,
        coalesce(
          (select max(t.created_at) from public.token_transactions t where t.user_id = u.id),
          u.created_at
        ) as last_active,
        (
          coalesce((select count(*) from public.cad_jobs c where c.user_id = u.id), 0)
        + coalesce((select count(*) from public.meshes  m where m.user_id = u.id), 0)
        ) as generations,
        coalesce((select sum(-t.amount) from public.token_transactions t
                    where t.user_id = u.id and t.amount < 0 and t.operation not in ('refund','admin_adjustment')), 0) as tokens_consumed,
        %s as actual_cost_usd,
        (
          coalesce((select sum(p.price_cents) from public.token_transactions tt
                      join public.token_pack_products p on p.token_amount = tt.amount
                     where tt.user_id = u.id and tt.source = 'purchased'
                       and tt.operation = 'chat' and tt.amount > 0), 0)
          + case coalesce(sub.level::text, 'free')
              when 'max' then 150000
              when 'pro' then 15000
              when 'standard' then 3000
              else 0 end
        ) as revenue_cents
      from auth.users u
      left join profiles pr on pr.user_id = u.id
      left join lateral (
        select s.level, s.status
          from public.subscriptions s
         where s.user_id = u.id
         order by (s.status in ('active','trialing')) desc, s.created_at desc
         limit 1
      ) sub on true
      where ($1 is null or u.email ilike '%%' || $1 || '%%' or pr.full_name ilike '%%' || $1 || '%%')
    ),
    enriched as (
      select
        b.*,
        (b.tokens_consumed * 0.01)::numeric as est_cost_usd
      from base b
    )
    select
      e.user_id, e.email, e.full_name, e.plan, e.sub_status, e.created_at,
      e.last_active, e.generations, e.tokens_consumed, e.est_cost_usd,
      coalesce(e.actual_cost_usd, (e.tokens_consumed * 0.01)::numeric) as actual_cost_usd,
      e.revenue_cents,
      count(*) over() as total_count
    from enriched e
    order by %I %s, e.user_id asc
    limit %s offset %s
  $q$, v_actual, v_sort_col, v_order, v_limit, v_offset);

  return query execute v_sql using p_search;
end;
$$;

-- Re-lock execution: service_role only (mirrors the canonical files).
revoke all on function public.admin_overview()                              from public;
revoke all on function public.admin_daily_activity(int)                     from public;
revoke all on function public.admin_top_users(int)                          from public;
revoke all on function public.admin_user_detail(uuid)                       from public;
revoke all on function public.admin_cost_breakdown()                        from public;
revoke all on function public.admin_cost_daily(int)                         from public;
revoke all on function public.admin_growth_weekly(int)                      from public;
revoke all on function public.admin_retention_cohorts(int)                  from public;
revoke all on function public.admin_users_page(text, int, int, text, text)  from public;

grant execute on function public.admin_overview()                              to service_role;
grant execute on function public.admin_daily_activity(int)                     to service_role;
grant execute on function public.admin_top_users(int)                          to service_role;
grant execute on function public.admin_user_detail(uuid)                       to service_role;
grant execute on function public.admin_cost_breakdown()                        to service_role;
grant execute on function public.admin_cost_daily(int)                         to service_role;
grant execute on function public.admin_growth_weekly(int)                      to service_role;
grant execute on function public.admin_retention_cohorts(int)                  to service_role;
grant execute on function public.admin_users_page(text, int, int, text, text)  to service_role;
