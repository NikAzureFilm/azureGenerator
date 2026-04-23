import {
  createClient,
  SupabaseClient as DefaultSupabaseClient,
  SupabaseClientOptions,
} from 'https://esm.sh/@supabase/supabase-js@2.49.9';
import { Database } from '@shared/database.ts';

export type SupabaseClient = DefaultSupabaseClient<Database>;

// Trim to guard against copy-pasted env vars with trailing newlines,
// which make fetch() throw "Invalid header value" on any API call.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')?.trim() ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')?.trim() ?? '';

export function getServiceRoleSupabaseClient(
  options?: SupabaseClientOptions<'public'>,
): SupabaseClient {
  return createClient<Database, 'public', Database['public']>(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      ...options,
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

export function getAnonSupabaseClient(
  options?: SupabaseClientOptions<'public'>,
): SupabaseClient {
  return createClient<Database, 'public', Database['public']>(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    options,
  );
}
