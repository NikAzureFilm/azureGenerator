import { NextResponse, type NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth';
import { getAdminClient } from '@/lib/supabaseAdmin';
import {
  isMissingFunctionError,
  parseTokenAdjustBody,
} from '@/lib/apiValidation';

export const dynamic = 'force-dynamic';

// POST /api/users/:id/tokens  { amount, source, note }
// Manual credit/debit of a user's token balance via the admin_adjust_tokens
// RPC. Admin-guarded like the asset route.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  const parsed = parseTokenAdjustBody(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: 400 },
    );
  }
  const { amount, source, note } = parsed.value;

  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_adjust_tokens', {
    p_user_id: id,
    p_amount: amount,
    p_source: source,
    p_note: note,
  });

  if (error) {
    // RPC not applied yet: undefined_function (42883) or PostgREST no-match
    // (PGRST202). Surface an actionable message.
    if (isMissingFunctionError(error)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'admin_adjust_tokens missing — apply admin/sql/patches/2026-07-07-admin-adjust-tokens-*.sql',
        },
        { status: 501 },
      );
    }
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  // Pass the RPC's jsonb result through. It already carries success + balances,
  // or success:false with an error string for domain-level rejections.
  const result = (data ?? {}) as Record<string, unknown>;
  const ok = result.success !== false;
  return NextResponse.json({ ok, ...result }, { status: ok ? 200 : 400 });
}
