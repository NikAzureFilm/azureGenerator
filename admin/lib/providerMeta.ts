// Static, display-only metadata for each provider: console / API-key / billing /
// status links, the live-credit strategy, and the edge-function secret name that
// key management operates on. The set of secretNames here IS the allowlist of
// manageable secrets — SUPABASE_*, BILLING_SERVICE_*, SENTRY_DSN and
// TEXT_TO_CAD_WORKER_TOKEN are deliberately excluded, so the admin UI can never
// reach them. Secret names mirror supabase/functions/.env.template; `provider`
// matches the provider_kind enum value.

export type ProviderMeta = {
  provider: string; // matches the provider_kind enum value
  label: string; // display name
  secretName: string | null; // edge-function secret env var; null = not key-managed
  dashboardUrl: string | null;
  keysUrl: string | null;
  billingUrl: string | null;
  statusUrl: string | null;
  credits: 'openrouter' | 'fal' | null; // live-credit strategy; null = none
};

export const PROVIDER_META: readonly ProviderMeta[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    secretName: 'ANTHROPIC_API_KEY',
    dashboardUrl: 'https://console.anthropic.com',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    billingUrl: 'https://console.anthropic.com/settings/billing',
    statusUrl: 'https://status.anthropic.com',
    credits: null,
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    secretName: 'OPENAI_API_KEY',
    dashboardUrl: 'https://platform.openai.com',
    keysUrl: 'https://platform.openai.com/api-keys',
    billingUrl:
      'https://platform.openai.com/settings/organization/billing/overview',
    statusUrl: 'https://status.openai.com',
    credits: null,
  },
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    secretName: 'OPENROUTER_API_KEY',
    dashboardUrl: 'https://openrouter.ai',
    keysUrl: 'https://openrouter.ai/settings/keys',
    billingUrl: 'https://openrouter.ai/settings/credits',
    statusUrl: null,
    credits: 'openrouter',
  },
  {
    provider: 'google',
    label: 'Google',
    secretName: 'GOOGLE_API_KEY',
    dashboardUrl: 'https://aistudio.google.com',
    keysUrl: 'https://aistudio.google.com/apikey',
    billingUrl: 'https://console.cloud.google.com/billing',
    statusUrl: null,
    credits: null,
  },
  {
    provider: 'fal',
    label: 'fal',
    secretName: 'FAL_KEY',
    dashboardUrl: 'https://fal.ai/dashboard',
    keysUrl: 'https://fal.ai/dashboard/keys',
    billingUrl: 'https://fal.ai/dashboard/billing',
    statusUrl: null,
    credits: 'fal',
  },
  {
    // Internal docker worker — no external console, not key-managed.
    provider: 'worker',
    label: 'Worker',
    secretName: null,
    dashboardUrl: null,
    keysUrl: null,
    billingUrl: null,
    statusUrl: null,
    credits: null,
  },
];

export function metaFor(provider: string): ProviderMeta | null {
  return PROVIDER_META.find((m) => m.provider === provider) ?? null;
}
