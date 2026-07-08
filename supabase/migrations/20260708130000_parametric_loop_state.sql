-- Authoritative server-side state for the agentic parametric generation loop.
--
-- The assistant message's `content.loop` jsonb is client-writable (users can
-- update their own messages) and client-readable (public conversations), so it
-- can be forged or replayed. This table is the ONLY source of truth the edge
-- function trusts for loop decisions (caps, round, repairs, spend, ownership).
-- `content.loop` is kept purely as a non-authoritative display mirror for the
-- UI.
--
-- Written and updated exclusively by the parametric-chat edge function using
-- the service-role key. Like provider_usage / the token tables, RLS is enabled
-- with NO anon/authenticated policies, so the browser clients can never read or
-- write it.

create table if not exists "public"."parametric_loop_state" (
  "message_id" uuid not null,
  "user_id" uuid not null,
  "conversation_id" uuid not null,
  "tier" text not null,
  "round" integer not null default 0,
  "repairs" integer not null default 0,
  "spent_usd" numeric(12, 6) not null default 0,
  "status" text not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  constraint "parametric_loop_state_pkey" primary key ("message_id")
);

alter table "public"."parametric_loop_state" enable row level security;

-- Ownership / recency lookups.
create index if not exists "parametric_loop_state_user_idx"
  on "public"."parametric_loop_state" ("user_id", "created_at" desc);

-- service_role bypasses RLS; explicitly lock the PostgREST app roles out so the
-- table is never exposed to the browser even if a policy is added later.
revoke all on table "public"."parametric_loop_state" from anon, authenticated;
grant all on table "public"."parametric_loop_state" to service_role;
