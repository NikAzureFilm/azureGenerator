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
    'ever_subscribed', (select count(distinct user_id) from subscriptions),
    'canceled', (select count(distinct user_id) from subscriptions where status = 'canceled')
  );
$$;
