CREATE OR REPLACE FUNCTION "public"."update_conversation_leaf"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  update conversations set 
    current_message_leaf_id = new.id,
    updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$;

CREATE OR REPLACE TRIGGER "update_leaf_trigger" AFTER INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."update_conversation_leaf"();

-- Mesh token refund triggers
-- Tokens are deducted before mesh creation now, refunded on failure

-- Function to handle mesh status updates (refund tokens on failure)
CREATE OR REPLACE FUNCTION handle_mesh_status_update()
RETURNS TRIGGER AS $$
BEGIN
    -- If mesh status changed to 'failure', refund the tokens
    IF OLD.status != 'failure' AND NEW.status = 'failure' THEN
        PERFORM public.refund_tokens(NEW.user_id, 'mesh'::public.token_operation_type, NEW.id::text);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for mesh status updates
CREATE OR REPLACE TRIGGER mesh_status_update_trigger
    AFTER UPDATE ON public.meshes
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION handle_mesh_status_update();

-- Previews updated_at trigger
-- Function to update the updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at for previews
CREATE OR REPLACE TRIGGER update_previews_updated_at 
    BEFORE UPDATE ON "public"."previews" 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Profile creation trigger for new users
-- Create function to handle new user sign ups
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

-- Create trigger to automatically create profile on user creation
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
