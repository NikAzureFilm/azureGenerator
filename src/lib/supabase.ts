import { createClient } from '@supabase/supabase-js';
import { Database } from '@shared/database';

// Trim to guard against copy-pasted env vars with a trailing newline,
// which otherwise leaks into Realtime URLs as %0A and breaks the WS handshake.
const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const rawSupabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

// Flag used by the UI to show a helpful message instead of crashing
export const isSupabaseConfigMissing = !rawSupabaseUrl || !rawSupabaseKey;

// Fallback values keep the client constructable so imports don't throw
// when env vars are missing. The app should gate on isSupabaseConfigMissing
// and avoid making real requests in this state.
const supabaseUrl = rawSupabaseUrl || 'http://localhost';
const supabaseKey = rawSupabaseKey || 'public-anon-key';

export const supabase = createClient<Database>(supabaseUrl, supabaseKey);
