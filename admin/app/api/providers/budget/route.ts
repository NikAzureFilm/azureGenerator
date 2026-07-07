import { NextResponse, type NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth';
import {
  BudgetsTableMissingError,
  upsertProviderBudget,
} from '@/lib/providers';

export const dynamic = 'force-dynamic';

const MAX_BUDGET_USD = 1_000_000;

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

  let provider: unknown;
  let monthlyBudgetUsd: unknown;
  try {
    const body = await req.json();
    provider = body.provider;
    monthlyBudgetUsd = body.monthlyBudgetUsd;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  if (typeof provider !== 'string' || !provider.trim()) {
    return NextResponse.json(
      { ok: false, error: 'provider is required' },
      { status: 400 },
    );
  }

  let budget: number | null;
  if (monthlyBudgetUsd === null) {
    budget = null;
  } else if (
    typeof monthlyBudgetUsd === 'number' &&
    Number.isFinite(monthlyBudgetUsd) &&
    monthlyBudgetUsd >= 0 &&
    monthlyBudgetUsd <= MAX_BUDGET_USD
  ) {
    budget = monthlyBudgetUsd;
  } else {
    return NextResponse.json(
      {
        ok: false,
        error: `monthlyBudgetUsd must be null or a number between 0 and ${MAX_BUDGET_USD}`,
      },
      { status: 400 },
    );
  }

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
