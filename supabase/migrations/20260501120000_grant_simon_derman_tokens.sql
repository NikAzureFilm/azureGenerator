-- One-off manual grant for Simon Derman.

DO $$
DECLARE
    v_user_id uuid;
BEGIN
    SELECT id INTO v_user_id
    FROM auth.users
    WHERE id = 'afe18369-c014-435b-8f1c-bbbb412e3cd2'::uuid
      AND lower(email) = 'simon.derman@gmail.com';

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Expected Simon Derman user simon.derman@gmail.com was not found';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.token_transactions
        WHERE reference_id = 'manual_grant_simon_derman_20260501'
    ) THEN
        PERFORM public.credit_purchased_tokens(
            v_user_id,
            1000,
            'manual_grant_simon_derman_20260501'
        );
    END IF;
END $$;
