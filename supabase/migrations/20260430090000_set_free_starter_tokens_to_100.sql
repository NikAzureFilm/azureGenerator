-- Replace recurring free daily tokens with a one-time 100-token starter grant.

CREATE OR REPLACE FUNCTION public.get_subscription_token_limit(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql STABLE
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

CREATE OR REPLACE FUNCTION public.ensure_free_tier_fresh(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_free_tier_tokens()
RETURNS void
LANGUAGE plpgsql
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

-- Clamp old starter-only free balances without touching paid token-pack buyers.
UPDATE public.token_balances tb
SET balance = LEAST(tb.balance, 100),
    updated_at = now()
WHERE tb.source = 'purchased'
AND tb.balance > 100
AND NOT EXISTS (
    SELECT 1 FROM public.subscriptions s
    WHERE s.user_id = tb.user_id
    AND s.status IN ('active', 'trialing')
)
AND NOT EXISTS (
    SELECT 1 FROM public.token_transactions tt
    WHERE tt.user_id = tb.user_id
    AND tt.source = 'purchased'
    AND tt.amount > 0
);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      split_part(NEW.email, '@', 1)
    )
  );

  -- Initialize one-time starter token balance
  INSERT INTO public.token_balances (user_id, source, balance)
  VALUES (NEW.id, 'purchased'::public.token_source_type, 100);

  RETURN NEW;
END;
$$;
