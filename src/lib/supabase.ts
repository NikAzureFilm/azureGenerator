import { createClient } from '@supabase/supabase-js';
import { Database } from '@shared/database';
import { normalizeViteEnv } from './viteEnv';

// Normalize both real and escaped trailing newlines. A literal `\n` in the URL
// becomes `/n` in the browser and sends Auth requests to the wrong endpoint.
const rawSupabaseUrl = normalizeViteEnv(import.meta.env.VITE_SUPABASE_URL);
const rawSupabaseKey = normalizeViteEnv(import.meta.env.VITE_SUPABASE_ANON_KEY);

// Flag used by the UI to show a helpful message instead of crashing
export const isSupabaseConfigMissing = !rawSupabaseUrl || !rawSupabaseKey;

// Fallback values keep the client constructable so imports don't throw
// when env vars are missing. The app should gate on isSupabaseConfigMissing
// and avoid making real requests in this state.
export const supabaseUrl = rawSupabaseUrl || 'http://localhost';
const supabaseKey = rawSupabaseKey || 'public-anon-key';

export const supabase = createClient<Database>(supabaseUrl, supabaseKey);

export function getSupabaseFunctionUrl(functionName: string): string {
  return `${supabaseUrl.replace(/\/$/, '')}/functions/v1/${functionName}`;
}
