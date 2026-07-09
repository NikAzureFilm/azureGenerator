-- Record the PAID (round-0) code-gen model on the authoritative loop-state row.
--
-- Continuations derive per-model behavior (inspection maxRounds, the reviewer
-- model, the code-gen model + its output cap) from the model id. That id was
-- being read from the assistant message's `content.model` jsonb, which is
-- client-writable (owners can UPDATE their own message content) and only checked
-- against the roster allow-list. A user could buy the cheap Lite tier
-- (0 inspection rounds) and then rewrite content.model to a premium model to get
-- extra reviewer + revise rounds the tier didn't pay for.
--
-- Persisting the validated round-0 model here — alongside tier/round/spend, in
-- the same service-role-only, RLS-locked table — makes it authoritative: the
-- continuation handler prefers this column over the forgeable content.model.
-- Nullable so in-flight rows created before this migration keep working (the
-- edge function falls back to content.model when the column is null).
alter table "public"."parametric_loop_state"
  add column if not exists "model" text;
