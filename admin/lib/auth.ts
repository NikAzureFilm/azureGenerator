import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';

export const ACCESS_COOKIE = 'sb-access-token';
export const REFRESH_COOKIE = 'sb-refresh-token';

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.toLowerCase());
}

// A bare anon client used purely to validate/refresh login JWTs.
export function getAuthClient() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY.');
  }
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type AdminUser = { id: string; email: string };

// Returns the signed-in admin, or null if not authenticated / not allowlisted.
export async function getAdminUser(): Promise<AdminUser | null> {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  if (!token) return null;

  const supa = getAuthClient();
  const { data, error } = await supa.auth.getUser(token);
  if (error || !data.user?.email) return null;
  if (!isAdminEmail(data.user.email)) return null;
  return { id: data.user.id, email: data.user.email };
}

// Server-component guard: redirects to /login when not an admin.
export async function requireAdmin(): Promise<AdminUser> {
  const user = await getAdminUser();
  if (!user) redirect('/login');
  return user;
}
