import { NextResponse, type NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth';
import {
  BudgetsTableMissingError,
  upsertProviderBudget,
} from '@/lib/providers';
import { parseBudgetBody } from '@/lib/apiValidation';

export const dynamic = 'force-dynamic';

// POST /api/providers/budget  { provider: string, monthlyBudgetUsd: number|null }
// Sets (or clears, when null) a provider's monthly USD budget. Admin-guarded
// exactly like the asset route.
export async function POST(req: NextRequest) {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  const parsed = parseBudgetBody(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: 400 },
    );
  }
  const { provider, monthlyBudgetUsd: budget } = parsed.value;

  try {
    await upsertProviderBudget(provider, budget);
  } catch (error) {
    // Budgets table not applied yet → actionable 501, like the tokens route.
    if (error instanceof BudgetsTableMissingError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 501 },
      );
    }
    const message =
      error instanceof Error ? error.message : 'Failed to save budget';
    // Unknown provider / validation failure from the data layer.
    const status = /unknown provider|required/i.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }

  return NextResponse.json({ ok: true });
}
