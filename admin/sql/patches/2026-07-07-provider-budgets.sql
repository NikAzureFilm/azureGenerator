-- Patch: admin_provider_budgets — per-provider monthly USD spend budgets.
-- Paste this whole file into the Supabase SQL editor and run it. NOT applied
-- automatically. The matching migration lives at
-- supabase/migrations/20260707120000_admin_provider_budgets.sql; the repo keeps
-- the two in sync.
--
-- Until this is applied, the /providers page still renders: the budget read
-- detects the missing table (42P01) and shows an "apply the patch" banner with
-- all budgets null.
--
-- Mirrors the provider_usage conventions: RLS enabled with NO policies (so the
-- normal app clients can never read it), all privileges revoked from the
-- PostgREST app roles, service_role only.

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
