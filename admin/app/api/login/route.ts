import { NextResponse } from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  getAuthClient,
  isAdminEmail,
} from '@/lib/auth';

export async function POST(req: Request) {
  let email = '';
  let password = '';
  try {
    const body = await req.json();
    email = String(body.email ?? '');
    password = String(body.password ?? '');
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  if (!email || !password) {
    return NextResponse.json(
      { error: 'Email and password required' },
      { status: 400 },
    );
  }

  if (!isAdminEmail(email)) {
    // Don't sign in non-admins at all.
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const supa = getAuthClient();
  const { data, error } = await supa.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.session || !data.user?.email) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  if (!isAdminEmail(data.user.email)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true });
  const secure = process.env.NODE_ENV === 'production';
  const session = data.session;

  res.cookies.set(ACCESS_COOKIE, session.access_token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    // match the JWT lifetime; middleware refreshes from the refresh cookie
    maxAge: session.expires_in ?? 3600,
  });
  res.cookies.set(REFRESH_COOKIE, session.refresh_token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  return res;
}
