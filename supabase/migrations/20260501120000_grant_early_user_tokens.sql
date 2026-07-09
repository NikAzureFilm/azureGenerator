-- One-off manual token grant for an early production user, identified by
-- account UUID only.
--
-- Already applied in production under version 20260501120000; Supabase
-- tracks applied migrations by version, so editing this file never
-- re-executes it there. On fresh/local databases the user is absent and
-- the grant is skipped.

DO $$
DECLARE
    v_user_id uuid;
BEGIN
    SELECT id INTO v_user_id
    FROM auth.users
    WHERE id = 'afe18369-c014-435b-8f1c-bbbb412e3cd2'::uuid;

    IF v_user_id IS NULL THEN
        -- Absent on fresh/local databases; the grant only applies where the
        -- production user exists. Hard-failing here broke `supabase db reset`.
        RAISE NOTICE 'Grant recipient not found; skipping one-off grant';
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.token_transactions
        WHERE reference_id = 'manual_grant_20260501'
    ) THEN
        PERFORM public.credit_purchased_tokens(
            v_user_id,
            1000,
            'manual_grant_20260501'
        );
    END IF;
END $$;
