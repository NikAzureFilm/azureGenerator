-- Patch: admin_provider_costs — per-provider spend aggregated over ALL of
-- provider_usage (not just the newest 20k rows), so month-to-date spend and
-- budget alerts are accurate even in a >20k-row month. Paste this whole file
-- into the Supabase SQL editor and run it. NOT applied automatically.
--
-- The /providers page tries this RPC first and falls back to a bounded 20k-row
-- JS aggregation when it's absent (PGRST202/42883). While on the fallback path
-- with a truncated read, the page shows a "spend figures are lower bounds"
-- banner until this patch is applied.
--
-- Matching migration: supabase/migrations/20260707120300_admin_provider_costs_rpc.sql
--
-- SECURITY DEFINER + service_role-only, mirroring admin_metrics.sql /
-- admin_explorer.sql. Guarded with to_regclass so it degrades to an empty set
-- when provider_usage doesn't exist yet.

create or replace function public.admin_provider_costs()
returns table(
  provider              text,
  mtd_cost_usd          numeric,
  mtd_calls             bigint,
  failed_mtd_cost_usd   numeric,
  prev_month_cost_usd   numeric,
  last30d_cost_usd      numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_pu boolean := to_regclass('public.provider_usage') is not null;
begin
  if not v_has_pu then
    return;
  end if;

  return query execute $q$
    with bounds as (
      -- UTC calendar-month edges as timestamptz (TimeZone-independent): floor to
      -- the UTC month, then reinterpret the wall-clock as UTC. Both sides of the
      -- created_at comparisons are then timestamptz, so the session TimeZone
      -- can't skew the boundaries.
      select
        (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') as month_start,
        ((date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC') as next_month_start,
        ((date_trunc('month', now() at time zone 'UTC') - interval '1 month') at time zone 'UTC') as prev_month_start,
        (now() - interval '30 days') as last30d_start
    )
    select
      pu.provider::text as provider,
      coalesce(sum(pu.cost_usd) filter (
        where pu.created_at >= (select month_start from bounds)
          and pu.created_at <  (select next_month_start from bounds)
      ), 0)::numeric as mtd_cost_usd,
      count(*) filter (
        where pu.created_at >= (select month_start from bounds)
          and pu.created_at <  (select next_month_start from bounds)
      )::bigint as mtd_calls,
      coalesce(sum(pu.cost_usd) filter (
        where pu.created_at >= (select month_start from bounds)
          and pu.created_at <  (select next_month_start from bounds)
          and coalesce(pu.status, 'success') <> 'success'
      ), 0)::numeric as failed_mtd_cost_usd,
      coalesce(sum(pu.cost_usd) filter (
        where pu.created_at >= (select prev_month_start from bounds)
          and pu.created_at <  (select month_start from bounds)
      ), 0)::numeric as prev_month_cost_usd,
      coalesce(sum(pu.cost_usd) filter (
        where pu.created_at >= (select last30d_start from bounds)
      ), 0)::numeric as last30d_cost_usd
    from public.provider_usage pu
    group by pu.provider
  $q$;
end;
$$;

revoke all on function public.admin_provider_costs() from public, anon, authenticated;
grant execute on function public.admin_provider_costs() to service_role;
