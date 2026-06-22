-- =============================================================================
-- Admin dashboard aggregation functions
-- =============================================================================
-- These run with SECURITY DEFINER so they can aggregate across ALL users'
-- rows (the underlying tables are protected by per-user RLS). Execution is
-- REVOKEd from anon/authenticated and granted ONLY to service_role, which is
-- the key the admin dashboard uses server-side. They are never reachable from
-- the normal app's anon/authenticated clients.
--
-- Apply once against the production database, either via:
--   supabase db execute --file admin/sql/admin_metrics.sql
-- or by pasting into the Supabase SQL editor.
--
-- Re-running is safe (CREATE OR REPLACE).
-- =============================================================================

-- High-level KPIs in a single round trip ------------------------------------
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
                       where created_at >= now() - interval '30 days' and amount < 0),
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
                           where amount < 0 and operation <> 'refund'),
      'consumed_30d',   (select coalesce(sum(-amount),0) from token_transactions
                           where amount < 0 and operation <> 'refund'
                             and created_at >= now() - interval '30 days'),
      'by_operation',   (select coalesce(jsonb_object_agg(operation, total), '{}'::jsonb)
                           from (select operation, sum(-amount) as total
                                   from token_transactions
                                  where amount < 0 and operation <> 'refund'
                                  group by operation) t),
      'refunded',             (select coalesce(sum(amount),0) from token_transactions where operation = 'refund'),
      'balance_subscription', (select coalesce(sum(balance),0) from token_balances where source = 'subscription'),
      'balance_purchased',    (select coalesce(sum(balance),0) from token_balances where source = 'purchased'),
      -- tokens credited via paid token-pack purchases (credit_purchased_tokens)
      'purchased_credited',   (select coalesce(sum(amount),0) from token_transactions
                                 where source = 'purchased' and operation = 'chat' and amount > 0)
    ),
    'revenue', jsonb_build_object(
      -- DB-derived MRR. Mirrors shared/pricingCatalog.ts monthlyPriceCents.
      -- NOTE: the subscriptions table does not record billing interval, so this
      -- assumes monthly billing; treat as active-plan MRR, not cash collected.
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
      -- Historical token-pack revenue, derived by matching credited token
      -- amounts back to token_pack_products pricing.
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

-- Daily time series (signups, generations, tokens consumed) ------------------
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
         and t.amount < 0 and t.operation <> 'refund')
  from series s
  order by s.day;
$$;

-- Recent generation feed (CAD jobs + meshes), newest first ------------------
create or replace function public.admin_recent_generations(p_limit int default 30)
returns table(
  kind text,
  id uuid,
  status text,
  created_at timestamptz,
  user_email text,
  title text
)
language sql
security definer
set search_path = public, auth
as $$
  select * from (
    (select 'cad'::text as kind, c.id, c.status::text, c.created_at, u.email, conv.title
       from cad_jobs c
       join auth.users u on u.id = c.user_id
       left join conversations conv on conv.id = c.conversation_id
      order by c.created_at desc
      limit p_limit)
    union all
    (select 'mesh'::text as kind, m.id, m.status::text, m.created_at, u.email, conv.title
       from meshes m
       join auth.users u on u.id = m.user_id
       left join conversations conv on conv.id = m.conversation_id
      order by m.created_at desc
      limit p_limit)
    union all
    (select 'image'::text as kind, i.id, i.status::text, i.created_at, u.email, conv.title
       from images i
       join auth.users u on u.id = i.user_id
       left join conversations conv on conv.id = i.conversation_id
      order by i.created_at desc
      limit p_limit)
  ) feed
  order by created_at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 200);
$$;

-- Top users by tokens consumed ----------------------------------------------
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
                where t.user_id = u.id and t.amount < 0 and t.operation <> 'refund'), 0) as tokens_consumed,
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

-- Lock down execution: service_role only ------------------------------------
revoke all on function public.admin_overview()                 from public;
revoke all on function public.admin_daily_activity(int)        from public;
revoke all on function public.admin_recent_generations(int)    from public;
revoke all on function public.admin_top_users(int)             from public;

grant execute on function public.admin_overview()              to service_role;
grant execute on function public.admin_daily_activity(int)     to service_role;
grant execute on function public.admin_recent_generations(int) to service_role;
grant execute on function public.admin_top_users(int)          to service_role;
