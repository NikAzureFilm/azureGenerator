-- One-off manual grant for all users that exist when this migration runs.

DO $$
DECLARE
    v_user record;
    v_reference_id text := 'manual_grant_all_current_users_3000_20260518';
BEGIN
    FOR v_user IN
        SELECT id
        FROM auth.users
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM public.token_transactions
            WHERE user_id = v_user.id
              AND reference_id = v_reference_id
        ) THEN
            PERFORM public.credit_purchased_tokens(
                v_user.id,
                3000,
                v_reference_id
            );
        END IF;
    END LOOP;
END $$;
