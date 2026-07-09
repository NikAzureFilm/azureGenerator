import { NextResponse, type NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth';
import { parseKeySetBody } from '@/lib/apiValidation';
import { metaFor } from '@/lib/providerMeta';

export const dynamic = 'force-dynamic';

// POST /api/providers/keys/test  { provider, apiKey }
//
// Tests a PASTED key against the provider's cheap validation endpoint. Stored
// keys can never be read back (the Management API only returns digests), so a
// test always operates on the key in the request body and stores nothing.
//
// A well-formed test returns HTTP 200 with { ok, detail?/error }: the test RAN,
// and an invalid key is a RESULT, not a route error. 400/401 are reserved for
// validation/auth. The key is never echoed back.

const TEST_TIMEOUT_MS = 8_000;

type TestResult = { ok: true; detail?: string } | { ok: false; error: string };

function unauthorized() {
  return NextResponse.json(
    { ok: false, error: 'Unauthorized' },
    { status: 401 },
  );
}

// GET a validation endpoint with the given headers; 2xx = accepted, 401/403 =
// rejected, anything else = a value-free "returned <status>".
async function testSimple(
  url: string,
  headers: Record<string, string>,
): Promise<TestResult> {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (res.ok) return { ok: true, detail: 'key accepted' };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'key rejected (401/403)' };
  }
  return { ok: false, error: `validation endpoint returned ${res.status}` };
}

async function testOpenrouter(key: string): Promise<TestResult> {
  const res = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'key rejected (401/403)' };
  }
  if (!res.ok) {
    return { ok: false, error: `validation endpoint returned ${res.status}` };
  }
  const body: unknown = await res.json().catch(() => null);
  const data =
    body && typeof body === 'object' ? (body as { data?: unknown }).data : null;
  const rec =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const usage = rec ? Number(rec.usage) : NaN;
  const limit = rec ? Number(rec.limit) : NaN;
  if (Number.isFinite(usage)) {
    const detail = Number.isFinite(limit)
      ? `key accepted — usage $${usage.toFixed(2)} of $${limit.toFixed(2)}`
      : `key accepted — usage $${usage.toFixed(2)}`;
    return { ok: true, detail };
  }
  return { ok: true, detail: 'key accepted' };
}

async function testFal(key: string): Promise<TestResult> {
  const res = await fetch('https://api.fal.ai/v1/account/billing', {
    headers: { Authorization: `Key ${key}` },
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'key rejected or not admin-scoped (401/403)' };
  }
  if (!res.ok) {
    return { ok: false, error: `validation endpoint returned ${res.status}` };
  }
  return { ok: true, detail: 'key accepted' };
}

async function testProviderKey(
  provider: string,
  key: string,
): Promise<TestResult> {
  try {
    switch (provider) {
      case 'anthropic':
        return await testSimple('https://api.anthropic.com/v1/models', {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        });
      case 'openai':
        return await testSimple('https://api.openai.com/v1/models', {
          Authorization: `Bearer ${key}`,
        });
      case 'openrouter':
        return await testOpenrouter(key);
      case 'google':
        return await testSimple(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
          {},
        );
      case 'fal':
        return await testFal(key);
      default:
        return { ok: false, error: 'no validation endpoint for this provider' };
    }
  } catch {
    return { ok: false, error: 'test request failed (network or timeout)' };
  }
}

export async function POST(req: NextRequest) {
  const admin = await getAdminUser();
  if (!admin) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  const parsed = parseKeySetBody(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: 400 },
    );
  }

  const provider = parsed.value.provider.trim().toLowerCase();
  const meta = metaFor(provider);
  if (!meta || !meta.secretName) {
    return NextResponse.json(
      {
        ok: false,
        error: `unknown or non-testable provider: ${parsed.value.provider}`,
      },
      { status: 400 },
    );
  }

  // HTTP 200: the test ran; an invalid key is reported in the body, not a status.
  const result = await testProviderKey(provider, parsed.value.apiKey);
  return NextResponse.json(result);
}
