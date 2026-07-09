import 'server-only';

// ===========================================================================
// Thin client for the Supabase Management API (https://api.supabase.com), used
// to read / set / delete the edge-function secrets that back provider API keys.
//
// SECURITY: the personal access token and any secret value must never appear in
// a thrown message, a log line, or a response. Every error raised here carries
// only an HTTP status plus a short, static reason phrase — never a response
// body (which could echo request data) and never the token.
// ===========================================================================

const API_BASE = 'https://api.supabase.com';
const TIMEOUT_MS = 10_000;

// Thrown by the mutating ops when the management token / project ref isn't
// configured, so API routes can return an actionable 501 (mirrors
// BudgetsTableMissingError in lib/providers.ts).
export class ManagementUnavailableError extends Error {
  constructor() {
    super(
      'Supabase Management API not configured — set SUPABASE_ACCESS_TOKEN (and optionally SUPABASE_PROJECT_REF) in the admin environment.',
    );
    this.name = 'ManagementUnavailableError';
  }
}

// Project ref: an explicit SUPABASE_PROJECT_REF wins; otherwise the first
// hostname label of SUPABASE_URL (e.g. https://abcd.supabase.co → "abcd").
function projectRef(): string | null {
  const explicit = process.env.SUPABASE_PROJECT_REF?.trim();
  if (explicit) return explicit;
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.split('.')[0] || null;
  } catch {
    return null;
  }
}

function accessToken(): string | null {
  return process.env.SUPABASE_ACCESS_TOKEN?.trim() || null;
}

export function managementAvailable(): boolean {
  return accessToken() !== null && projectRef() !== null;
}

async function managementFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = accessToken();
  const ref = projectRef();
  if (!token || !ref) throw new ManagementUnavailableError();

  const res = await fetch(`${API_BASE}/v1/projects/${ref}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) {
    // Value-free by construction: status + reason phrase only.
    throw new Error(
      `Supabase Management API ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
    );
  }
  return res;
}

type SecretEntry = { name?: unknown; value?: unknown };

// GET the project's secrets. The API returns each secret's value as its SHA-256
// digest (never plaintext), so the returned map is name → digest.
export async function listSecretDigests(): Promise<Map<string, string>> {
  const res = await managementFetch('GET', '/secrets');
  const data: unknown = await res.json().catch(() => null);
  const map = new Map<string, string>();
  if (Array.isArray(data)) {
    for (const entry of data as SecretEntry[]) {
      if (
        entry &&
        typeof entry.name === 'string' &&
        typeof entry.value === 'string'
      ) {
        map.set(entry.name, entry.value);
      }
    }
  }
  return map;
}

// Bulk upsert: POST a JSON array of {name, value}. Posting an existing name
// overwrites it (this is what `supabase secrets set` does).
export async function setSecrets(
  entries: { name: string; value: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  await managementFetch('POST', '/secrets', entries);
}

// Bulk delete: DELETE with a JSON array of secret names in the request body.
export async function deleteSecrets(names: string[]): Promise<void> {
  if (names.length === 0) return;
  await managementFetch('DELETE', '/secrets', names);
}
