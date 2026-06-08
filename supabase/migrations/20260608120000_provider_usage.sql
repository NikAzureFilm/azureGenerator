-- Actual external-provider API cost per generation (our COGS in USD).
--
-- Distinct from token_transactions, which is the CUSTOMER-facing token ledger.
-- Rows here record what WE pay providers (Anthropic, OpenRouter, OpenAI,
-- Gemini, fal.ai) for each call. They are inserted by edge functions using the
-- service-role key, which bypasses RLS. Like the other token tables, RLS is
-- enabled with NO anon/authenticated policies, so the normal app clients can
-- never read it; the admin dashboard reads aggregates through SECURITY DEFINER
-- functions granted only to service_role.

do $$ begin
  create type "public"."provider_kind" as enum (
    'anthropic', 'openai', 'openrouter', 'google', 'fal', 'worker'
  );
exception
  when duplicate_object then null;
end $$;


  create table if not exists "public"."provider_usage" (
    "id" bigint generated always as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "user_id" uuid,
    "function_name" text not null,
    "operation" text not null,
    "provider" public.provider_kind not null,
    "model" text not null,
    "input_tokens" integer,
    "output_tokens" integer,
    "cached_input_tokens" integer,
    "request_units" numeric(12,4),
    "unit" text,
    "cost_usd" numeric(12,6) not null default 0,
    "pricing_source" text not null default 'catalog',
    "reference_id" text,
    "conversation_id" uuid,
    "status" text not null default 'success',
    "metadata" jsonb not null default '{}'::jsonb,
    constraint "provider_usage_pkey" primary key ("id")
      );


alter table "public"."provider_usage" enable row level security;

-- Reporting indexes (admin aggregations filter by time / provider / operation /
-- model, and join per-user).
create index if not exists "provider_usage_created_at_idx" on "public"."provider_usage" ("created_at" desc);
create index if not exists "provider_usage_provider_idx"   on "public"."provider_usage" ("provider", "created_at" desc);
create index if not exists "provider_usage_operation_idx"  on "public"."provider_usage" ("operation", "created_at" desc);
create index if not exists "provider_usage_model_idx"      on "public"."provider_usage" ("model");
create index if not exists "provider_usage_user_idx"       on "public"."provider_usage" ("user_id", "created_at" desc);
create index if not exists "provider_usage_reference_idx"  on "public"."provider_usage" ("reference_id");

-- service_role bypasses RLS; explicitly lock the PostgREST app roles out so the
-- table is never exposed to the browser even if a policy is added later.
revoke all on table "public"."provider_usage" from anon, authenticated;
grant all on table "public"."provider_usage" to service_role;
