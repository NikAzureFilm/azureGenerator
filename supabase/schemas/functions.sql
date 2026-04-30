-- Get token allotment for a user's tier
CREATE OR REPLACE FUNCTION "public"."get_subscription_token_limit"("p_user_id" uuid)
RETURNS integer
LANGUAGE "plpgsql" STABLE
AS $$
DECLARE
    userlevel public.subscriptions.level%TYPE;
    userstatus public.subscriptions.status%TYPE;
BEGIN
    SELECT status, level INTO userstatus, userlevel
    FROM public.subscriptions
    WHERE user_id = p_user_id;

    IF userstatus = 'active' OR userstatus = 'trialing' THEN
        IF userlevel = 'pro' THEN
            RETURN 5000;
        ELSIF userlevel = 'standard' THEN
            RETURN 1000;
        END IF;
    END IF;

    -- Free tier
    RETURN 0;
END;
$$;
-- Compatibility no-op for older callers. Free-tier users no longer receive
-- recurring subscription tokens; new accounts get a one-time starter grant.
CREATE OR REPLACE FUNCTION "public"."ensure_free_tier_fresh"("p_user_id" uuid)
RETURNS void
LANGUAGE "plpgsql"
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN;
END;
$$;

-- Atomic token deduction
CREATE OR REPLACE FUNCTION "public"."deduct_tokens"(
    "p_user_id" uuid,
    "p_operation" "public"."token_operation_type",
    "p_reference_id" text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE "plpgsql"
AS $$
DECLARE
    v_cost integer;
    v_sub_balance integer;
    v_pur_balance integer;
    v_sub_expires timestamptz;
    v_remaining integer;
    v_sub_deduct integer;
    v_pur_deduct integer;
BEGIN
    -- Get cost for operation
    SELECT cost INTO v_cost FROM public.token_costs WHERE operation = p_operation;
    IF v_cost IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'unknown_operation');
    END IF;

    PERFORM public.ensure_free_tier_fresh(p_user_id);

    -- Lock and read subscription balance
    SELECT balance, expires_at INTO v_sub_balance, v_sub_expires
    FROM public.token_balances
    WHERE user_id = p_user_id AND source = 'subscription'
    FOR UPDATE;

    -- Expired subscription tokens count as 0. This is load-bearing for paid
    -- users whose billing-cycle subscription balance has lapsed.
    IF v_sub_expires IS NOT NULL AND v_sub_expires < now() THEN
        v_sub_balance := 0;
    END IF;

    -- Lock and read purchased balance
    SELECT balance INTO v_pur_balance
    FROM public.token_balances
    WHERE user_id = p_user_id AND source = 'purchased'
    FOR UPDATE;

    -- Default to 0 if no rows exist
    v_sub_balance := COALESCE(v_sub_balance, 0);
    v_pur_balance := COALESCE(v_pur_balance, 0);

    -- Check total available
    IF (v_sub_balance + v_pur_balance) < v_cost THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'insufficient_tokens',
            'tokensRequired', v_cost,
            'tokensAvailable', v_sub_balance + v_pur_balance
        );
    END IF;

    -- Consume subscription tokens first (they expire anyway)
    v_sub_deduct := LEAST(v_cost, v_sub_balance);
    v_pur_deduct := v_cost - v_sub_deduct;

    -- Update subscription balance
    IF v_sub_deduct > 0 THEN
        UPDATE public.token_balances
        SET balance = balance - v_sub_deduct, updated_at = now()
        WHERE user_id = p_user_id AND source = 'subscription';
    END IF;

    -- Update purchased balance
    IF v_pur_deduct > 0 THEN
        UPDATE public.token_balances
        SET balance = balance - v_pur_deduct, updated_at = now()
        WHERE user_id = p_user_id AND source = 'purchased';
    END IF;

    -- Record transaction
    INSERT INTO public.token_transactions (
        user_id, operation, amount, source, reference_id,
        subscription_balance_after, purchased_balance_after
    ) VALUES (
        p_user_id, p_operation, -v_cost,
        CASE WHEN v_sub_deduct > 0 THEN 'subscription'::public.token_source_type ELSE 'purchased'::public.token_source_type END,
        p_reference_id,
        v_sub_balance - v_sub_deduct,
        v_pur_balance - v_pur_deduct
    );

    RETURN jsonb_build_object(
        'success', true,
        'tokensDeducted', v_cost,
        'subscriptionBalance', v_sub_balance - v_sub_deduct,
        'purchasedBalance', v_pur_balance - v_pur_deduct,
        'totalBalance', (v_sub_balance - v_sub_deduct) + (v_pur_balance - v_pur_deduct)
    );
END;
$$;

-- Refund tokens on failed operations
CREATE OR REPLACE FUNCTION "public"."refund_tokens"(
    "p_user_id" uuid,
    "p_operation" "public"."token_operation_type",
    "p_reference_id" text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE "plpgsql"
AS $$
DECLARE
    v_cost integer;
    v_sub_balance integer;
    v_pur_balance integer;
    v_sub_limit integer;
    v_sub_refund integer;
    v_pur_refund integer;
BEGIN
    -- Get cost for operation
    SELECT cost INTO v_cost FROM public.token_costs WHERE operation = p_operation;
    IF v_cost IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'unknown_operation');
    END IF;

    -- Get current balances with lock
    SELECT balance INTO v_sub_balance
    FROM public.token_balances
    WHERE user_id = p_user_id AND source = 'subscription'
    FOR UPDATE;

    SELECT balance INTO v_pur_balance
    FROM public.token_balances
    WHERE user_id = p_user_id AND source = 'purchased'
    FOR UPDATE;

    v_sub_balance := COALESCE(v_sub_balance, 0);
    v_pur_balance := COALESCE(v_pur_balance, 0);

    -- Get subscription tier limit
    v_sub_limit := public.get_subscription_token_limit(p_user_id);

    -- Refund to subscription first (up to tier limit), remainder to purchased
    v_sub_refund := LEAST(v_cost, v_sub_limit - v_sub_balance);
    v_sub_refund := GREATEST(v_sub_refund, 0);
    v_pur_refund := v_cost - v_sub_refund;

    -- Update balances
    IF v_sub_refund > 0 THEN
        UPDATE public.token_balances
        SET balance = balance + v_sub_refund, updated_at = now()
        WHERE user_id = p_user_id AND source = 'subscription';
    END IF;

    IF v_pur_refund > 0 THEN
        UPDATE public.token_balances
        SET balance = balance + v_pur_refund, updated_at = now()
        WHERE user_id = p_user_id AND source = 'purchased';
    END IF;

    -- Record refund transaction
    INSERT INTO public.token_transactions (
        user_id, operation, amount, source, reference_id,
        subscription_balance_after, purchased_balance_after
    ) VALUES (
        p_user_id, 'refund'::public.token_operation_type, v_cost,
        CASE WHEN v_sub_refund > 0 THEN 'subscription'::public.token_source_type ELSE 'purchased'::public.token_source_type END,
        p_reference_id,
        v_sub_balance + v_sub_refund,
        v_pur_balance + v_pur_refund
    );

    RETURN jsonb_build_object(
        'success', true,
        'tokensRefunded', v_cost,
        'subscriptionBalance', v_sub_balance + v_sub_refund,
        'purchasedBalance', v_pur_balance + v_pur_refund
    );
END;
$$;

-- Credit purchased tokens from Stripe one-time payments
CREATE OR REPLACE FUNCTION "public"."credit_purchased_tokens"(
    "p_user_id" uuid,
    "p_amount" integer,
    "p_reference_id" text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE "plpgsql"
AS $$
DECLARE
    v_new_balance integer;
    v_sub_balance integer;
BEGIN
    INSERT INTO public.token_balances (user_id, source, balance)
    VALUES (p_user_id, 'purchased'::public.token_source_type, p_amount)
    ON CONFLICT (user_id, source) DO UPDATE
    SET balance = token_balances.balance + p_amount, updated_at = now()
    RETURNING balance INTO v_new_balance;

    SELECT COALESCE(balance, 0) INTO v_sub_balance
    FROM public.token_balances
    WHERE user_id = p_user_id AND source = 'subscription'::public.token_source_type;

    v_sub_balance := COALESCE(v_sub_balance, 0);

    INSERT INTO public.token_transactions (
        user_id, operation, amount, source, reference_id,
        subscription_balance_after, purchased_balance_after
    ) VALUES (
        p_user_id, 'chat'::public.token_operation_type, p_amount, 'purchased'::public.token_source_type, p_reference_id,
        v_sub_balance, v_new_balance
    );

    RETURN jsonb_build_object(
        'success', true,
        'tokensAdded', p_amount,
        'purchasedBalance', v_new_balance
    );
END;
$$;

-- Reset subscription tokens on billing cycle renewal
CREATE OR REPLACE FUNCTION "public"."grant_subscription_tokens"(
    "p_user_id" uuid,
    "p_token_amount" integer,
    "p_expires_at" timestamptz
)
RETURNS jsonb
LANGUAGE "plpgsql"
AS $$
DECLARE
    v_pur_balance integer;
BEGIN
    INSERT INTO public.token_balances (user_id, source, balance, expires_at)
    VALUES (p_user_id, 'subscription'::public.token_source_type, p_token_amount, p_expires_at)
    ON CONFLICT (user_id, source) DO UPDATE
    SET balance = p_token_amount, expires_at = p_expires_at, updated_at = now();

    SELECT COALESCE(balance, 0) INTO v_pur_balance
    FROM public.token_balances
    WHERE user_id = p_user_id AND source = 'purchased'::public.token_source_type;

    v_pur_balance := COALESCE(v_pur_balance, 0);

    INSERT INTO public.token_transactions (
        user_id, operation, amount, source, reference_id,
        subscription_balance_after, purchased_balance_after
    ) VALUES (
        p_user_id, 'chat'::public.token_operation_type, p_token_amount, 'subscription'::public.token_source_type, 'subscription_grant',
        p_token_amount, v_pur_balance
    );

    RETURN jsonb_build_object(
        'success', true,
        'tokensGranted', p_token_amount,
        'subscriptionBalance', p_token_amount,
        'expiresAt', p_expires_at
    );
END;
$$;

-- Backstop retained for old cron/manual calls. Free-tier users no longer get
-- recurring subscription tokens, so this clears stale free subscription rows.
CREATE OR REPLACE FUNCTION "public"."reset_free_tier_tokens"()
RETURNS void
LANGUAGE "plpgsql"
AS $$
BEGIN
    UPDATE public.token_balances tb
    SET balance = 0,
        expires_at = now(),
        updated_at = now()
    WHERE tb.source = 'subscription'
    AND NOT EXISTS (
        SELECT 1 FROM public.subscriptions s
        WHERE s.user_id = tb.user_id
        AND s.status IN ('active', 'trialing')
    )
    AND tb.balance <> 0;
END;
$$;

-- User extra data function (returns token balances)
CREATE OR REPLACE FUNCTION "public"."user_extradata"("user_id_input" "uuid")
RETURNS "public"."user_data"
LANGUAGE "plpgsql"
AS $$
DECLARE
    hasTrialed boolean;
    userlevel public.subscriptions.level%TYPE;
    userstatus public.subscriptions.status%TYPE;
    v_sub_balance integer;
    v_pur_balance integer;
    v_sub_expires timestamptz;
    v_sub_limit integer;
    ret user_data;
BEGIN
    PERFORM public.ensure_free_tier_fresh(user_id_input);

    -- Get trial status
    SELECT (
        (SELECT count(*) FROM public.trial_users WHERE user_id = user_id_input) > 0
    ) INTO hasTrialed;

    -- Get subscription info
    SELECT STATUS, LEVEL INTO userstatus, userlevel
    FROM public.subscriptions
    WHERE user_id = user_id_input;

    -- Get token balances
    SELECT balance, expires_at INTO v_sub_balance, v_sub_expires
    FROM public.token_balances
    WHERE user_id = user_id_input AND source = 'subscription';

    SELECT balance INTO v_pur_balance
    FROM public.token_balances
    WHERE user_id = user_id_input AND source = 'purchased';

    v_sub_balance := COALESCE(v_sub_balance, 0);
    v_pur_balance := COALESCE(v_pur_balance, 0);

    -- See matching comment in deduct_tokens: this branch is load-bearing for
    -- paid users whose billing-cycle subscription balance has lapsed.
    IF v_sub_expires IS NOT NULL AND v_sub_expires < now() THEN
        v_sub_balance := 0;
    END IF;

    -- Set return values
    ret."hasTrialed" = hasTrialed;

    -- Set subscription level
    IF (userstatus = 'active') THEN
        ret."sublevel" = userlevel;
    ELSIF (userstatus = 'trialing') THEN
        ret."sublevel" = 'pro';
    ELSE
        ret."sublevel" = 'free';
    END IF;

    -- Get token limit for tier
    v_sub_limit := public.get_subscription_token_limit(user_id_input);

    -- Set token values
    ret."subscriptionTokens" = v_sub_balance;
    ret."purchasedTokens" = v_pur_balance;
    ret."totalTokens" = v_sub_balance + v_pur_balance;
    ret."subscriptionTokenLimit" = v_sub_limit;
    ret."subscriptionExpiresAt" = v_sub_expires;

    RETURN ret;

EXCEPTION
    WHEN others THEN
        RAISE EXCEPTION 'An error occurred in function user_extradata(): %', SQLERRM;
END;
$$;
