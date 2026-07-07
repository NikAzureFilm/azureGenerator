-- Patch (1 of 2): add the 'admin_adjustment' value to token_operation_type.
--
-- MUST be applied as its own statement/file, BEFORE
-- 2026-07-07-admin-adjust-tokens-2-rpc.sql. A newly added enum value cannot be
-- referenced in the same transaction that adds it, so the RPC that inserts
-- token_transactions rows with operation = 'admin_adjustment' has to live in a
-- separate migration/patch that runs afterwards.
--
-- Matching migration: supabase/migrations/20260707120100_token_admin_adjustment_enum.sql
-- Idempotent via IF NOT EXISTS.

alter type public.token_operation_type add value if not exists 'admin_adjustment';
