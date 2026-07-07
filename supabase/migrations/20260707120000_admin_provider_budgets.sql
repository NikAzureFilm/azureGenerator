-- admin_provider_budgets — per-provider monthly USD spend budgets.
--
-- Read by the admin dashboard's /providers page to compare month-to-date and
-- projected provider spend against a configured budget. Written only through the
-- admin API (service-role key).
--
-- Mirrors the provider_usage conventions: RLS enabled with NO anon/authenticated
-- policies, all privileges revoked from the PostgREST app roles, service_role
-- only. The canonical dashboard copy lives at
-- admin/sql/patches/2026-07-07-provider-budgets.sql; the repo keeps them in sync.

create table if not exists "public"."admin_provider_budgets" (
  "provider" text primary key,
  "monthly_budget_usd" numeric(10,2) not null check (monthly_budget_usd >= 0),
  "updated_at" timestamptz not null default now()
);

alter table "public"."admin_provider_budgets" enable row level security;

-- service_role bypasses RLS; explicitly lock the PostgREST app roles out so the
-- table is never exposed to the browser even if a policy is added later.
revoke all on table "public"."admin_provider_budgets" from anon, authenticated;
grant all on table "public"."admin_provider_budgets" to service_role;
