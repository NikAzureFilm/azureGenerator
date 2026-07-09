import 'server-only';
import { PROVIDER_META } from './providerMeta';
import { listSecretDigests, managementAvailable } from './supabaseManagement';

// ===========================================================================
// Key-status + live-credit data layer for the /providers page.
//
// CONSTRAINT: the Management API secrets list returns each value as its SHA-256
// DIGEST, not plaintext — stored keys can never be read back. So key status is
// only set/unset plus a short digest fingerprint (change detection, no
// masking), and live credits are read with the admin's OWN provider keys from
// process.env (OPENROUTER_API_KEY / FAL_KEY), never from the stored secrets.
//
// fetchProviderKeys() must never throw: management-unconfigured →
// available:false; a configured-but-failed secrets read → available:true with a
// short transient error and empty keys; every credit read resolves to a
// CreditBalance (failures become {kind:'error'} with a value-free message).
// ===========================================================================

export type ProviderKeyInfo = {
  provider: string;
  secretName: string;
  isSet: boolean;
  // First 8 hex chars of the SHA-256 digest the API returns, as a
  // change-detection fingerprint; null when unset or the digest is malformed.
  digestShort: string | null;
};

export type CreditBalance =
  | {
      kind: 'openrouter';
      remainingUsd: number;
      totalCreditsUsd: number;
      totalUsageUsd: number;
    }
  | { kind: 'fal'; remainingUsd: number }
  | { kind: 'unconfigured' } // supports live credits but the admin env lacks the key
  | { kind: 'error'; message: string }; // short, value-free

export type ProviderKeysResult = {
  available: boolean; // managementAvailable()
  error: string | null; // transient management-API failure (page still renders)
  keys: ProviderKeyInfo[]; // one per PROVIDER_META entry with a secretName
  credits: Map<string, CreditBalance>; // provider → balance, for credit strategies
};

const CREDIT_TIMEOUT_MS = 8_000;

function digestShort(digest: string | undefined): string | null {
  if (!digest) return null;
  const hex = digest.replace(/^sha256:/i, '').trim();
  return /^[0-9a-f]{8,}$/i.test(hex) ? hex.slice(0, 8).toLowerCase() : null;
}

// Untrusted JSON fields: only an actual finite number counts. Number(null) would
// coerce to 0, so a null/absent balance must NOT read as a real $0.00 — return
// null and let the caller surface {kind:'error'}.
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function fetchOpenrouterCredit(): Promise<CreditBalance> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return { kind: 'unconfigured' };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(CREDIT_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { kind: 'error', message: `credits read failed (${res.status})` };
    }
    const body: unknown = await res.json().catch(() => null);
    const data =
      body && typeof body === 'object'
        ? (body as { data?: unknown }).data
        : null;
    const rec =
      data && typeof data === 'object'
        ? (data as Record<string, unknown>)
        : null;
    const total = rec ? finiteNumber(rec.total_credits) : null;
    const usage = rec ? finiteNumber(rec.total_usage) : null;
    if (total === null || usage === null) {
      return { kind: 'error', message: 'credits response malformed' };
    }
    return {
      kind: 'openrouter',
      remainingUsd: total - usage,
      totalCreditsUsd: total,
      totalUsageUsd: usage,
    };
  } catch {
    return { kind: 'error', message: 'credits request failed' };
  }
}

async function fetchFalCredit(): Promise<CreditBalance> {
  const key = process.env.FAL_KEY?.trim();
  if (!key) return { kind: 'unconfigured' };
  try {
    const res = await fetch(
      'https://api.fal.ai/v1/account/billing?expand=credits',
      {
        headers: { Authorization: `Key ${key}` },
        signal: AbortSignal.timeout(CREDIT_TIMEOUT_MS),
        cache: 'no-store',
      },
    );
    if (res.status === 401 || res.status === 403) {
      return {
        kind: 'error',
        message: 'fal billing read denied (admin-scoped key may be required)',
      };
    }
    if (!res.ok) {
      return { kind: 'error', message: `credits read failed (${res.status})` };
    }
    const body: unknown = await res.json().catch(() => null);
    const credits =
      body && typeof body === 'object'
        ? (body as { credits?: unknown }).credits
        : null;
    const rec =
      credits && typeof credits === 'object'
        ? (credits as Record<string, unknown>)
        : null;
    const balance = rec ? finiteNumber(rec.current_balance) : null;
    if (balance === null) {
      return { kind: 'error', message: 'credits response malformed' };
    }
    return { kind: 'fal', remainingUsd: balance };
  } catch {
    return { kind: 'error', message: 'credits request failed' };
  }
}

export async function fetchProviderKeys(): Promise<ProviderKeysResult> {
  // Live-credit reads use the admin's own env keys and are independent of the
  // management API, so run them regardless of managementAvailable(). Each
  // resolves to a CreditBalance and never throws.
  const creditJobs = PROVIDER_META.filter((m) => m.credits !== null).map(
    async (m) => {
      const balance =
        m.credits === 'openrouter'
          ? await fetchOpenrouterCredit()
          : await fetchFalCredit();
      return [m.provider, balance] as const;
    },
  );

  if (!managementAvailable()) {
    const credits = new Map(await Promise.all(creditJobs));
    return { available: false, error: null, keys: [], credits };
  }

  let digests: Map<string, string> | null = null;
  let error: string | null = null;
  try {
    digests = await listSecretDigests();
  } catch {
    // Value-free: never surface the management error detail to the page.
    error = 'Could not read secrets from the Supabase Management API.';
  }

  const credits = new Map(await Promise.all(creditJobs));

  if (!digests) {
    return { available: true, error, keys: [], credits };
  }

  const found = digests;
  const keys: ProviderKeyInfo[] = PROVIDER_META.filter(
    (m) => m.secretName !== null,
  ).map((m) => {
    const secretName = m.secretName as string;
    const digest = found.get(secretName);
    return {
      provider: m.provider,
      secretName,
      isSet: digest !== undefined,
      digestShort: digestShort(digest),
    };
  });

  return { available: true, error, keys, credits };
}
