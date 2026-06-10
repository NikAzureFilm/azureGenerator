-- =============================================================================
-- Admin dashboard — data explorer functions (users, costs, retention, funnel)
-- =============================================================================
-- Companion to admin_metrics.sql. These power the data-heavy expansion pages
-- (per-user explorer, cost breakdown, retention cohorts, conversion funnel).
--
-- Like admin_metrics.sql, every function runs with SECURITY DEFINER so it can
-- aggregate across ALL users' rows (the underlying tables are protected by
-- per-user RLS). Execution is REVOKEd from public and granted ONLY to
-- service_role, the key the admin dashboard uses server-side. These functions
-- are never reachable from the normal app's anon/authenticated clients.
--
-- Apply once against the production database, either via:
--   supabase db execute --file admin/sql/admin_explorer.sql
-- or by pasting into the Supabase SQL editor.
--
-- Re-running is safe (CREATE OR REPLACE + CREATE INDEX IF NOT EXISTS + guarded
-- DO blocks). Every read of the optional public.provider_usage table is guarded
-- with to_regclass(...) so the script and the pages it feeds work whether or
-- not that table exists yet.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Indexes (created FIRST so the functions below have support).
-- NOTE: on a hot production database, prefer running each of these individually
-- WITH CONCURRENTLY (outside a transaction) to avoid taking a heavy lock:
--   create index concurrently if not exists ... ;
-- Re-running with plain CREATE INDEX IF NOT EXISTS here is safe but will lock
-- the table briefly while building.
-- -----------------------------------------------------------------------------
create index if not exists idx_token_transactions_user_created
  on public.token_transactions (user_id, created_at desc);
create index if not exists idx_token_transactions_created
  on public.token_transactions (created_at);

create index if not exists idx_cad_jobs_user_created
  on public.cad_jobs (user_id, created_at desc);
create index if not exists idx_cad_jobs_created
  on public.cad_jobs (created_at);

create index if not exists idx_meshes_user_created
  on public.meshes (user_id, created_at desc);
create index if not exists idx_meshes_created
  on public.meshes (created_at);

create index if not exists idx_images_user_created
  on public.images (user_id, created_at desc);
create index if not exists idx_images_created
  on public.images (created_at);
create index if not exists idx_messages_conversation_created
  on public.messages (conversation_id, created_at);
create index if not exists idx_conversations_user_updated
  on public.conversations (user_id, updated_at desc);
create index if not exists idx_cad_jobs_conversation_created
  on public.cad_jobs (conversation_id, created_at desc);
create index if not exists idx_meshes_conversation_created
  on public.meshes (conversation_id, created_at desc);
create index if not exists idx_images_conversation_created
  on public.images (conversation_id, created_at desc);

create index if not exists idx_profiles_created
  on public.profiles (created_at);

-- Trigram index to keep ILIKE '%term%' searches on full_name fast at scale.
create extension if not exists pg_trgm;
create index if not exists idx_profiles_full_name_trgm
  on public.profiles using gin (full_name gin_trgm_ops);

-- provider_usage indexes — only when the (optional) table exists.
do $$
begin
  if to_regclass('public.provider_usage') is not null then
    execute 'create index if not exists idx_provider_usage_user_created on public.provider_usage (user_id, created_at)';
    execute 'create index if not exists idx_provider_usage_created on public.provider_usage (created_at)';
    execute 'create index if not exists idx_provider_usage_operation on public.provider_usage (operation)';
    execute 'create index if not exists idx_provider_usage_provider on public.provider_usage (provider)';
    execute 'create index if not exists idx_provider_usage_model on public.provider_usage (model)';
  end if;
end $$;

-- =============================================================================
-- 2. admin_users_page — paginated, searchable, sortable user table.
-- Returns one row per user PLUS total_count (count(*) over() on the post-search
-- set) so a single round trip yields both the page of data and the grand total.
-- Implemented in plpgsql with a parameterized dynamic query: p_search is bound
-- as $1 (injection-safe ILIKE), while the sort column and direction are
-- whitelisted before interpolation.
-- =============================================================================
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
  -- Whitelist the sort column → a concrete, safe expression alias.
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

  -- Per-user actual provider cost: only reference provider_usage when present.
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
                    where t.user_id = u.id and t.amount < 0 and t.operation <> 'refund'), 0) as tokens_consumed,
        %s as actual_cost_usd,
        (
          coalesce((select sum(p.price_cents) from public.token_transactions tt
                      join public.token_pack_products p on p.token_amount = tt.amount
                     where tt.user_id = u.id and tt.source = 'purchased'
                       and tt.operation = 'chat' and tt.amount > 0), 0)
          + case coalesce(sub.level::text, 'free')
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

-- =============================================================================
-- 3. admin_user_detail — full per-user dossier as a single jsonb blob.
-- =============================================================================
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
                                    where user_id = p_user_id and amount < 0 and operation <> 'refund'), 0),
      'consumed_30d',   coalesce((select sum(-amount) from token_transactions
                                    where user_id = p_user_id and amount < 0 and operation <> 'refund'
                                      and created_at >= now() - interval '30 days'), 0),
      'by_operation',   coalesce((
        select jsonb_object_agg(operation, total)
          from (select operation, sum(-amount) as total
                  from token_transactions
                 where user_id = p_user_id and amount < 0 and operation <> 'refund'
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

-- =============================================================================
-- 4. admin_user_generations — recent CAD jobs + meshes for one user.
-- =============================================================================
create or replace function public.admin_user_generations(
  p_user_id uuid,
  p_limit   int default 50
)
returns table(
  kind       text,
  id         uuid,
  status     text,
  created_at timestamptz,
  title      text,
  file_type  text
)
language sql
security definer
set search_path = public
as $$
  select * from (
    (select 'cad'::text as kind, c.id, c.status::text, c.created_at,
            conv.title, null::text as file_type
       from cad_jobs c
       left join conversations conv on conv.id = c.conversation_id
      where c.user_id = p_user_id
      order by c.created_at desc
      limit p_limit)
    union all
    (select 'mesh'::text as kind, m.id, m.status::text, m.created_at,
            conv.title, m.file_type::text
       from meshes m
       left join conversations conv on conv.id = m.conversation_id
      where m.user_id = p_user_id
      order by m.created_at desc
      limit p_limit)
  ) feed
  order by created_at desc
  limit p_limit;
$$;

-- =============================================================================
-- 4b. Generation, prompt, and conversation detail explorers.
-- =============================================================================
-- The original signature had no p_status; drop it so the new definition does
-- not become an ambiguous overload (PostgREST refuses ambiguous RPC calls).
drop function if exists public.admin_generations_page(text, text, int, int);

create or replace function public.admin_generations_page(
  p_search text default null,
  p_kind   text default null,
  p_status text default null,
  p_limit  int  default 50,
  p_offset int  default 0
)
returns table(
  kind               text,
  id                 uuid,
  status             text,
  created_at         timestamptz,
  user_id            uuid,
  email              text,
  conversation_id    uuid,
  conversation_title text,
  conversation_type  text,
  prompt             jsonb,
  file_type          text,
  message_id         uuid,
  error              text,
  total_count        bigint
)
language sql
security definer
set search_path = public, auth
as $$
  with feed as (
    select
      'cad'::text as kind,
      c.id,
      c.status::text as status,
      c.created_at,
      c.user_id,
      u.email::text as email,
      c.conversation_id,
      conv.title as conversation_title,
      conv.type::text as conversation_type,
      c.prompt,
      null::text as file_type,
      c.message_id,
      c.error
    from cad_jobs c
    join auth.users u on u.id = c.user_id
    left join conversations conv on conv.id = c.conversation_id

    union all

    select
      'mesh'::text as kind,
      m.id,
      m.status::text as status,
      m.created_at,
      m.user_id,
      u.email::text as email,
      m.conversation_id,
      conv.title as conversation_title,
      conv.type::text as conversation_type,
      m.prompt,
      m.file_type::text as file_type,
      null::uuid as message_id,
      null::text as error
    from meshes m
    join auth.users u on u.id = m.user_id
    left join conversations conv on conv.id = m.conversation_id

    union all

    select
      'image'::text as kind,
      i.id,
      i.status::text as status,
      i.created_at,
      i.user_id,
      u.email::text as email,
      i.conversation_id,
      conv.title as conversation_title,
      conv.type::text as conversation_type,
      i.prompt,
      null::text as file_type,
      null::uuid as message_id,
      null::text as error
    from images i
    join auth.users u on u.id = i.user_id
    left join conversations conv on conv.id = i.conversation_id
  ),
  filtered as (
    select *
    from feed f
    where (
      p_kind is null
      or btrim(p_kind) = ''
      or lower(p_kind) = 'all'
      or f.kind = lower(p_kind)
    )
    and (
      p_status is null
      or btrim(p_status) = ''
      or lower(p_status) = 'all'
      or f.status = lower(p_status)
    )
    and (
      p_search is null
      or btrim(p_search) = ''
      or f.email ilike '%' || p_search || '%'
      or f.conversation_title ilike '%' || p_search || '%'
      or f.prompt::text ilike '%' || p_search || '%'
      or f.id::text ilike '%' || p_search || '%'
      or f.conversation_id::text ilike '%' || p_search || '%'
      or f.user_id::text ilike '%' || p_search || '%'
    )
  )
  select
    f.kind,
    f.id,
    f.status,
    f.created_at,
    f.user_id,
    f.email,
    f.conversation_id,
    f.conversation_title,
    f.conversation_type,
    f.prompt,
    f.file_type,
    f.message_id,
    f.error,
    count(*) over() as total_count
  from filtered f
  order by f.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.admin_user_generation_details(
  p_user_id uuid,
  p_limit   int default 50
)
returns table(
  kind            text,
  id              uuid,
  status          text,
  created_at      timestamptz,
  title           text,
  file_type       text,
  conversation_id uuid,
  prompt          jsonb,
  message_id      uuid,
  error           text
)
language sql
security definer
set search_path = public
as $$
  select * from (
    (select 'cad'::text as kind, c.id, c.status::text, c.created_at,
            conv.title, null::text as file_type, c.conversation_id, c.prompt,
            c.message_id, c.error
       from cad_jobs c
       left join conversations conv on conv.id = c.conversation_id
      where c.user_id = p_user_id
      order by c.created_at desc
      limit p_limit)
    union all
    (select 'mesh'::text as kind, m.id, m.status::text, m.created_at,
            conv.title, m.file_type::text, m.conversation_id, m.prompt,
            null::uuid as message_id, null::text as error
       from meshes m
       left join conversations conv on conv.id = m.conversation_id
      where m.user_id = p_user_id
      order by m.created_at desc
      limit p_limit)
    union all
    (select 'image'::text as kind, i.id, i.status::text, i.created_at,
            conv.title, null::text as file_type, i.conversation_id, i.prompt,
            null::uuid as message_id, null::text as error
       from images i
       left join conversations conv on conv.id = i.conversation_id
      where i.user_id = p_user_id
      order by i.created_at desc
      limit p_limit)
  ) feed
  order by created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function public.admin_user_conversations(
  p_user_id uuid,
  p_limit   int default 50
)
returns table(
  id                 uuid,
  title              text,
  type               text,
  privacy            text,
  created_at         timestamptz,
  updated_at         timestamptz,
  message_count      bigint,
  cad_jobs           bigint,
  meshes             bigint,
  images             bigint,
  latest_message_at  timestamptz,
  latest_user_prompt jsonb
)
language sql
security definer
set search_path = public
as $$
  select
    c.id,
    c.title,
    c.type::text,
    c.privacy::text,
    c.created_at,
    c.updated_at,
    (select count(*) from messages m where m.conversation_id = c.id) as message_count,
    (select count(*) from cad_jobs j where j.conversation_id = c.id) as cad_jobs,
    (select count(*) from meshes mh where mh.conversation_id = c.id) as meshes,
    (select count(*) from images im where im.conversation_id = c.id) as images,
    (select max(m.created_at) from messages m where m.conversation_id = c.id) as latest_message_at,
    (select m.content from messages m
      where m.conversation_id = c.id and m.role = 'user'
      order by m.created_at desc
      limit 1) as latest_user_prompt
  from conversations c
  where c.user_id = p_user_id
  order by coalesce(c.updated_at, c.created_at) desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function public.admin_conversation_detail(p_conversation_id uuid)
returns jsonb
language sql
security definer
set search_path = public, auth
as $$
  select jsonb_build_object(
    'conversation', (
      select jsonb_build_object(
        'id', c.id,
        'title', c.title,
        'type', c.type::text,
        'privacy', c.privacy::text,
        'created_at', c.created_at,
        'updated_at', c.updated_at,
        'user_id', c.user_id,
        'user_email', u.email,
        'settings', c.settings
      )
      from conversations c
      left join auth.users u on u.id = c.user_id
      where c.id = p_conversation_id
    ),
    'messages', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', m.id,
          'created_at', m.created_at,
          'role', m.role,
          'content', m.content,
          'rating', m.rating,
          'parent_message_id', m.parent_message_id
        )
        order by m.created_at asc
      )
      from messages m
      where m.conversation_id = p_conversation_id
    ), '[]'::jsonb),
    'generations', jsonb_build_object(
      'cad_jobs', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'kind', 'cad',
            'id', c.id,
            'status', c.status::text,
            'created_at', c.created_at,
            'prompt', c.prompt,
            'file_type', null,
            'message_id', c.message_id,
            'error', c.error
          )
          order by c.created_at desc
        )
        from cad_jobs c
        where c.conversation_id = p_conversation_id
      ), '[]'::jsonb),
      'meshes', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'kind', 'mesh',
            'id', m.id,
            'status', m.status::text,
            'created_at', m.created_at,
            'prompt', m.prompt,
            'file_type', m.file_type::text,
            'message_id', null,
            'error', null
          )
          order by m.created_at desc
        )
        from meshes m
        where m.conversation_id = p_conversation_id
      ), '[]'::jsonb),
      'images', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'kind', 'image',
            'id', i.id,
            'status', i.status::text,
            'created_at', i.created_at,
            'prompt', i.prompt,
            'file_type', null,
            'message_id', null,
            'error', null
          )
          order by i.created_at desc
        )
        from images i
        where i.conversation_id = p_conversation_id
      ), '[]'::jsonb)
    )
  );
$$;

-- =============================================================================
-- 5. admin_user_transactions — recent token ledger rows for one user.
-- =============================================================================
create or replace function public.admin_user_transactions(
  p_user_id uuid,
  p_limit   int default 50
)
returns table(
  id           bigint,
  operation    text,
  amount       int,
  source       text,
  reference_id text,
  created_at   timestamptz
)
language sql
security definer
set search_path = public
as $$
  select t.id, t.operation::text, t.amount, t.source::text, t.reference_id, t.created_at
    from token_transactions t
   where t.user_id = p_user_id
   order by t.created_at desc
   limit p_limit;
$$;

-- =============================================================================
-- 6. admin_cost_breakdown — provider cost vs token estimate vs revenue.
-- A leading guarded CTE makes all provider_usage aggregates 0/{} when the table
-- is absent, so the page renders a token-based estimate either way.
-- =============================================================================
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
    -- Token-consumption fallback so the page can show an estimated cost & margin
    -- (tokens × $0.01) even with no provider_usage data.
    'tokens_by_operation', coalesce((
      select jsonb_object_agg(operation, total)
        from (select operation, sum(-amount) as total
                from token_transactions
               where amount < 0 and operation <> 'refund'
               group by operation) t
    ), '{}'::jsonb),
    'revenue', jsonb_build_object(
      'mrr_cents', coalesce((
        select sum(case level when 'pro' then 15000 when 'standard' then 3000 else 0 end)
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

-- =============================================================================
-- 7. admin_cost_daily — daily actual cost, estimated cost, token-pack revenue,
-- signups over the last p_days days.
-- =============================================================================
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
                    and t.amount < 0 and t.operation <> 'refund'), 0) * 0.01::numeric as est_cost_usd,
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

-- =============================================================================
-- 8. admin_growth_weekly — per ISO week: signups, active users, new subs.
-- =============================================================================
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
                  and t.amount < 0 and t.operation <> 'refund'), 0) as active_users,
    coalesce((select count(*) from subscriptions sub
                where date_trunc('week', sub.created_at at time zone 'UTC')::date = s.week), 0) as new_subscriptions
  from series s
  order by s.week;
$$;

-- =============================================================================
-- 9. admin_retention_cohorts — long-form weekly retention triangle.
-- Each user's cohort is their signup week (profiles.created_at, fallback
-- auth.users.created_at), bounded to the last p_weeks cohorts. Activity = weeks
-- in which the user consumed tokens; week_offset is weeks since their cohort.
-- =============================================================================
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
     and t.operation <> 'refund'
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

-- =============================================================================
-- 10. admin_funnel — top-of-funnel conversion counts.
-- NOTE: the subscriptions table records no canceled_at / period timestamps, so
-- churn TIMING is not derivable. "canceled" here is a LIFETIME count of users
-- whose most-relevant subscription is currently status='canceled' — a proxy,
-- not a churn rate.
-- =============================================================================
create or replace function public.admin_funnel()
returns jsonb
language sql
security definer
set search_path = public, auth
as $$
  select jsonb_build_object(
    'signed_up', (select count(*) from auth.users),
    'generated_anything', (
      select count(distinct user_id) from (
        select user_id from cad_jobs
        union
        select user_id from meshes
        union
        select user_id from images
      ) g
    ),
    'currently_subscribed', (select count(distinct user_id) from subscriptions where status in ('active','trialing')),
    'ever_subscribed',  (select count(distinct user_id) from subscriptions),
    'canceled',         (select count(distinct user_id) from subscriptions where status = 'canceled')
  );
$$;

-- =============================================================================
-- Lock down execution: service_role only (mirrors admin_metrics.sql).
-- =============================================================================
revoke all on function public.admin_users_page(text, int, int, text, text) from public;
revoke all on function public.admin_user_detail(uuid)                       from public;
revoke all on function public.admin_user_generations(uuid, int)             from public;
revoke all on function public.admin_generations_page(text, text, text, int, int) from public;
revoke all on function public.admin_user_generation_details(uuid, int)      from public;
revoke all on function public.admin_user_conversations(uuid, int)           from public;
revoke all on function public.admin_conversation_detail(uuid)               from public;
revoke all on function public.admin_user_transactions(uuid, int)            from public;
revoke all on function public.admin_cost_breakdown()                        from public;
revoke all on function public.admin_cost_daily(int)                         from public;
revoke all on function public.admin_growth_weekly(int)                      from public;
revoke all on function public.admin_retention_cohorts(int)                  from public;
revoke all on function public.admin_funnel()                                from public;

grant execute on function public.admin_users_page(text, int, int, text, text) to service_role;
grant execute on function public.admin_user_detail(uuid)                       to service_role;
grant execute on function public.admin_user_generations(uuid, int)             to service_role;
grant execute on function public.admin_generations_page(text, text, text, int, int) to service_role;
grant execute on function public.admin_user_generation_details(uuid, int)      to service_role;
grant execute on function public.admin_user_conversations(uuid, int)           to service_role;
grant execute on function public.admin_conversation_detail(uuid)               to service_role;
grant execute on function public.admin_user_transactions(uuid, int)            to service_role;
grant execute on function public.admin_cost_breakdown()                        to service_role;
grant execute on function public.admin_cost_daily(int)                         to service_role;
grant execute on function public.admin_growth_weekly(int)                      to service_role;
grant execute on function public.admin_retention_cohorts(int)                  to service_role;
grant execute on function public.admin_funnel()                                to service_role;
