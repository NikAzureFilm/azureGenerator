import { NextResponse, type NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth';
import { getAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const MAX_ABS_AMOUNT = 100_000;
const SOURCES = new Set(['subscription', 'purchased']);

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

  let amount: unknown;
  let source: unknown;
  let note: unknown;
  try {
    const body = await req.json();
    amount = body.amount;
    source = body.source;
    note = body.note;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  if (
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount === 0 ||
    Math.abs(amount) > MAX_ABS_AMOUNT
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: `amount must be a non-zero integer with |amount| <= ${MAX_ABS_AMOUNT}`,
      },
      { status: 400 },
    );
  }

  if (typeof source !== 'string' || !SOURCES.has(source)) {
    return NextResponse.json(
      { ok: false, error: "source must be 'subscription' or 'purchased'" },
      { status: 400 },
    );
  }

  if (typeof note !== 'string' || !note.trim() || note.length > 200) {
    return NextResponse.json(
      { ok: false, error: 'note is required and must be <= 200 chars' },
      { status: 400 },
    );
  }

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
    if (error.code === '42883' || error.code === 'PGRST202') {
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
