import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/auth';

// When the short-lived access-token cookie has expired (dropped by the
// browser) but a refresh-token cookie remains, mint a fresh access token so
// the admin stays logged in without re-entering credentials.
export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const access = req.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;

  if (access || !refresh) return res;

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return res;

  try {
    const supa = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supa.auth.refreshSession({
      refresh_token: refresh,
    });
    if (!error && data.session) {
      const secure = process.env.NODE_ENV === 'production';
      res.cookies.set(ACCESS_COOKIE, data.session.access_token, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: data.session.expires_in ?? 3600,
      });
      res.cookies.set(REFRESH_COOKIE, data.session.refresh_token, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
    }
  } catch {
    // fall through; the page guard will redirect to /login if still unauthed
  }

  return res;
}

export const config = {
  // run on dashboard routes, not on static assets or the login/api endpoints
  matcher: [
    '/',
    '/users/:path*',
    '/costs',
    '/retention',
    '/generations/:path*',
    '/conversations/:path*',
    '/resources',
  ],
};
