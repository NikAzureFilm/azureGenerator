-- Add the 'admin_adjustment' value to token_operation_type.
--
-- MUST be its own migration, ordered BEFORE
-- 20260707120200_admin_adjust_tokens_rpc.sql. A newly added enum value cannot be
-- referenced in the same transaction that adds it, so the admin_adjust_tokens
-- RPC (which inserts token_transactions rows with operation = 'admin_adjustment')
-- lives in a separate, later migration.
--
-- Canonical dashboard copy: admin/sql/patches/2026-07-07-admin-adjust-tokens-1-enum.sql
-- Idempotent via IF NOT EXISTS.

alter type public.token_operation_type add value if not exists 'admin_adjustment';
