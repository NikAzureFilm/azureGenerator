// ===========================================================================
// Pure, unit-testable request-validation for the admin API routes.
//
// These functions carry the EXACT validation semantics that used to live inline
// in the route handlers (admin/app/api/users/[id]/tokens/route.ts and
// admin/app/api/providers/budget/route.ts): same limits, same error strings,
// same trimming/coercion rules. They take an already-parsed body (`unknown`)
// and return a discriminated result so the routes stay thin and every branch is
// testable without spinning up Next.js or touching a database.
//
// Status-code mapping that depends on route-only types stays in the routes; the
// pure error-classification shared between routes (the "missing RPC/function"
// PostgREST code check) lives here so both routes agree on it.
//
// Body-shape faithfulness: the original routes read `body.amount` (etc.) off the
// parsed JSON *inside* the req.json() try/catch. Property access on null/undefined
// throws, so those bodies were reported as 'Invalid request body'; a string,
// array, or number body does NOT throw on property access — it just exposes no
// matching fields, so it fell through to the field-level validation. Both parse
// functions reproduce that distinction exactly.
// ===========================================================================

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// Property access on these throws a TypeError; the routes caught that as an
// invalid body. Everything else (string/array/number/object) reads through to
// field validation.
function throwsOnPropertyAccess(body: unknown): boolean {
  return body === null || body === undefined;
}

// ---------------------------------------------------------------------------
// Token adjustment body: { amount, source, note }
// ---------------------------------------------------------------------------

const MAX_ABS_AMOUNT = 100_000;
const SOURCES = new Set(['subscription', 'purchased']);

export type TokenAdjustBody = {
  amount: number;
  source: string;
  note: string;
};

// Validates a manual credit/debit body. Mirrors the tokens route exactly:
//   - amount: number, integer, non-zero, |amount| <= 100000
//   - source: 'subscription' | 'purchased'
//   - note: string, non-empty after trim, RAW length <= 200 (the trim gates
//     emptiness; the length cap is measured on the untrimmed string, matching
//     the route's `!note.trim() || note.length > 200`)
export function parseTokenAdjustBody(
  body: unknown,
): ParseResult<TokenAdjustBody> {
  if (throwsOnPropertyAccess(body)) {
    return { ok: false, error: 'Invalid request body' };
  }

  const record = body as Record<string, unknown>;
  const amount: unknown = record.amount;
  const source: unknown = record.source;
  const note: unknown = record.note;

  if (
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount === 0 ||
    Math.abs(amount) > MAX_ABS_AMOUNT
  ) {
    return {
      ok: false,
      error: `amount must be a non-zero integer with |amount| <= ${MAX_ABS_AMOUNT}`,
    };
  }

  if (typeof source !== 'string' || !SOURCES.has(source)) {
    return {
      ok: false,
      error: "source must be 'subscription' or 'purchased'",
    };
  }

  if (typeof note !== 'string' || !note.trim() || note.length > 200) {
    return {
      ok: false,
      error: 'note is required and must be <= 200 chars',
    };
  }

  return { ok: true, value: { amount, source, note } };
}

// ---------------------------------------------------------------------------
// Provider budget body: { provider, monthlyBudgetUsd }
// ---------------------------------------------------------------------------

const MAX_BUDGET_USD = 1_000_000;

export type BudgetBody = {
  provider: string;
  monthlyBudgetUsd: number | null;
};

// Validates a provider-budget body. Mirrors the budget route exactly:
//   - provider: non-empty (after trim) string
//   - monthlyBudgetUsd: null (clear the budget) OR a finite number in [0, 1e6]
//
// No coercion: a string like "5" or a NaN/Infinity number is rejected, exactly
// as the route's `typeof === 'number' && Number.isFinite(...)` guard did. null is
// the sole non-number value accepted (it signals deletion).
export function parseBudgetBody(body: unknown): ParseResult<BudgetBody> {
  if (throwsOnPropertyAccess(body)) {
    return { ok: false, error: 'Invalid request body' };
  }

  const record = body as Record<string, unknown>;
  const provider: unknown = record.provider;
  const monthlyBudgetUsd: unknown = record.monthlyBudgetUsd;

  if (typeof provider !== 'string' || !provider.trim()) {
    return { ok: false, error: 'provider is required' };
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
    return {
      ok: false,
      error: `monthlyBudgetUsd must be null or a number between 0 and ${MAX_BUDGET_USD}`,
    };
  }

  return { ok: true, value: { provider, monthlyBudgetUsd: budget } };
}

// ---------------------------------------------------------------------------
// Provider API-key bodies: { provider, apiKey } (set/test) and { provider }
// (delete)
// ---------------------------------------------------------------------------

const MIN_KEY_LEN = 8;
const MAX_KEY_LEN = 512;

export type KeySetBody = {
  provider: string;
  apiKey: string;
};

export type KeyDeleteBody = {
  provider: string;
};

// Validates a key set/test body:
//   - provider: non-empty (after trim) string, passed through un-normalized
//     (the route maps it to a secret name via PROVIDER_META)
//   - apiKey: string; the accepted value is trimmed, must be 8–512 chars after
//     trimming, and must contain no whitespace or control characters
//
// The trimmed length is what's measured, so a whitespace-only key fails the
// length check (not the whitespace check).
export function parseKeySetBody(body: unknown): ParseResult<KeySetBody> {
  if (throwsOnPropertyAccess(body)) {
    return { ok: false, error: 'Invalid request body' };
  }

  const record = body as Record<string, unknown>;
  const provider: unknown = record.provider;
  const apiKey: unknown = record.apiKey;

  if (typeof provider !== 'string' || !provider.trim()) {
    return { ok: false, error: 'provider is required' };
  }

  if (typeof apiKey !== 'string') {
    return { ok: false, error: 'apiKey is required' };
  }

  const trimmed = apiKey.trim();
  if (trimmed.length < MIN_KEY_LEN || trimmed.length > MAX_KEY_LEN) {
    return {
      ok: false,
      error: `apiKey must be between ${MIN_KEY_LEN} and ${MAX_KEY_LEN} characters`,
    };
  }

  // Reject whitespace (code point <= 0x20) and control chars (DEL = 0x7f).
  if (
    [...trimmed].some(
      (ch) => (ch.codePointAt(0) ?? 0) <= 0x20 || ch.codePointAt(0) === 0x7f,
    )
  ) {
    return {
      ok: false,
      error: 'apiKey must not contain whitespace or control characters',
    };
  }

  return { ok: true, value: { provider, apiKey: trimmed } };
}

// Validates a key delete body: provider non-empty (after trim) string, passed
// through un-normalized.
export function parseKeyDeleteBody(body: unknown): ParseResult<KeyDeleteBody> {
  if (throwsOnPropertyAccess(body)) {
    return { ok: false, error: 'Invalid request body' };
  }

  const record = body as Record<string, unknown>;
  const provider: unknown = record.provider;

  if (typeof provider !== 'string' || !provider.trim()) {
    return { ok: false, error: 'provider is required' };
  }

  return { ok: true, value: { provider } };
}

// ---------------------------------------------------------------------------
// Shared error classification
// ---------------------------------------------------------------------------

// A Postgres/PostgREST error signalling the target function is missing:
// undefined_function (42883) or PostgREST no-match (PGRST202). The tokens route
// treats this as "the RPC hasn't been applied yet" → an actionable 501. Mirrors
// lib/providers.ts isMissingFunctionError so both agree on the codes.
export function isMissingFunctionError(error: {
  code?: string;
  message?: string;
}): boolean {
  return error.code === '42883' || error.code === 'PGRST202';
}
