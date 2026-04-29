-- Grant every newly-created user an initial non-expiring token balance.

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

  -- Initialize subscription token balance (free tier: 50 tokens, 1-day expiry)
  INSERT INTO public.token_balances (user_id, source, balance, expires_at)
  VALUES (NEW.id, 'subscription'::public.token_source_type, 50, now() + interval '1 day');

  -- Initialize purchased token balance (starter grant)
  INSERT INTO public.token_balances (user_id, source, balance)
  VALUES (NEW.id, 'purchased'::public.token_source_type, 3000);

  RETURN NEW;
END;
$$;
