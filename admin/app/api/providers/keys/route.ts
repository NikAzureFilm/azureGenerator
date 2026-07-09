import { NextResponse, type NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth';
import { parseKeyDeleteBody, parseKeySetBody } from '@/lib/apiValidation';
import { metaFor } from '@/lib/providerMeta';
import {
  ManagementUnavailableError,
  deleteSecrets,
  setSecrets,
} from '@/lib/supabaseManagement';

export const dynamic = 'force-dynamic';

// POST /api/providers/keys    { provider, apiKey } — set/replace the edge-function secret
// DELETE /api/providers/keys  { provider }         — remove it
//
// Admin-guarded like the budget route. PROVIDER_META is the allowlist: the
// client sends a provider, never a raw secret name, and a provider without a
// manageable secretName is a 400. The pasted key lives only in the outbound
// Management API call — it is never echoed in a response.

function unauthorized() {
  return NextResponse.json(
    { ok: false, error: 'Unauthorized' },
    { status: 401 },
  );
}

// Resolve a client-supplied provider to its manageable secret name, or null if
// the provider is unknown or deliberately not key-managed (e.g. worker).
function secretNameFor(provider: string): string | null {
  return metaFor(provider.trim().toLowerCase())?.secretName ?? null;
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

  const secretName = secretNameFor(parsed.value.provider);
  if (!secretName) {
    return NextResponse.json(
      {
        ok: false,
        error: `unknown or non-manageable provider: ${parsed.value.provider}`,
      },
      { status: 400 },
    );
  }

  try {
    await setSecrets([{ name: secretName, value: parsed.value.apiKey }]);
  } catch (error) {
    if (error instanceof ManagementUnavailableError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 501 },
      );
    }
    // Upstream Management API failure — message is value-free by construction.
    const message =
      error instanceof Error ? error.message : 'Failed to save key';
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
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

  const parsed = parseKeyDeleteBody(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: 400 },
    );
  }

  const secretName = secretNameFor(parsed.value.provider);
  if (!secretName) {
    return NextResponse.json(
      {
        ok: false,
        error: `unknown or non-manageable provider: ${parsed.value.provider}`,
      },
      { status: 400 },
    );
  }

  try {
    await deleteSecrets([secretName]);
  } catch (error) {
    if (error instanceof ManagementUnavailableError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 501 },
      );
    }
    const message =
      error instanceof Error ? error.message : 'Failed to remove key';
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
