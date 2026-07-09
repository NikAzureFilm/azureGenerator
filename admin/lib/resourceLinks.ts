import 'server-only';

export type ResourceLink = {
  label: string;
  href: string;
  description: string;
};

export type ResourceGroup = {
  title: string;
  links: ResourceLink[];
};

function getSupabaseProjectRef(): string | null {
  const url = process.env.SUPABASE_URL;
  if (!url) return null;

  try {
    const host = new URL(url).hostname;
    return host.endsWith('.supabase.co') ? host.split('.')[0] : null;
  } catch {
    return null;
  }
}

function supabaseLink(path: string, fallback: string): string {
  const ref = getSupabaseProjectRef();
  if (!ref) return fallback;
  return `https://supabase.com/dashboard/project/${ref}${path}`;
}

// Project names come from env so the public repo doesn't disclose them.
function vercelProjectLink(projectName: string | undefined): string {
  if (!projectName) return 'https://vercel.com/dashboard';
  const scope = process.env.VERCEL_TEAM_SLUG ?? process.env.VERCEL_SCOPE;
  if (!scope) {
    return `https://vercel.com/dashboard?query=${encodeURIComponent(projectName)}`;
  }
  return `https://vercel.com/${scope}/${projectName}`;
}

export function getResourceGroups(): ResourceGroup[] {
  return [
    {
      title: 'Production apps',
      links: [
        {
          label: 'Admin app',
          href: '/',
          description: 'This internal admin dashboard.',
        },
        {
          label: 'Customer app',
          href: 'https://azure-gen.vercel.app/',
          description: 'Live AzureFilm generation product.',
        },
        {
          label: 'GitHub repository',
          href: 'https://github.com/NikAzureFilm/azureGenerator',
          description: 'Source, issues, commits, and pull requests.',
        },
      ],
    },
    {
      title: 'Supabase',
      links: [
        {
          label: 'Project dashboard',
          href: supabaseLink('', 'https://supabase.com/dashboard/projects'),
          description: 'Project home, health, usage, and shortcuts.',
        },
        {
          label: 'Auth users',
          href: supabaseLink('/auth/users', 'https://supabase.com/dashboard'),
          description: 'User accounts, identities, and admin auth checks.',
        },
        {
          label: 'SQL editor',
          href: supabaseLink('/sql/new', 'https://supabase.com/dashboard'),
          description: 'Run admin SQL and inspect reporting functions.',
        },
        {
          label: 'Conversations table',
          href: supabaseLink(
            '/editor?schema=public&table=conversations',
            'https://supabase.com/dashboard',
          ),
          description: 'Conversation titles, owners, privacy, and settings.',
        },
        {
          label: 'Messages table',
          href: supabaseLink(
            '/editor?schema=public&table=messages',
            'https://supabase.com/dashboard',
          ),
          description: 'Stored user and assistant conversation turns.',
        },
        {
          label: 'CAD jobs table',
          href: supabaseLink(
            '/editor?schema=public&table=cad_jobs',
            'https://supabase.com/dashboard',
          ),
          description: 'Text-to-CAD jobs, prompts, artifacts, and errors.',
        },
        {
          label: 'Meshes table',
          href: supabaseLink(
            '/editor?schema=public&table=meshes',
            'https://supabase.com/dashboard',
          ),
          description: '3D mesh generations and prompt JSON.',
        },
        {
          label: 'Images table',
          href: supabaseLink(
            '/editor?schema=public&table=images',
            'https://supabase.com/dashboard',
          ),
          description: 'Reference/image generations and provider call ids.',
        },
        {
          label: 'Provider usage table',
          href: supabaseLink(
            '/editor?schema=public&table=provider_usage',
            'https://supabase.com/dashboard',
          ),
          description: 'Actual provider costs written by Edge Functions.',
        },
        {
          label: 'Edge Functions',
          href: supabaseLink('/functions', 'https://supabase.com/dashboard'),
          description: 'Generation, billing, mesh, and webhook functions.',
        },
        {
          label: 'Function logs',
          href: supabaseLink(
            '/logs/edge-functions',
            'https://supabase.com/dashboard',
          ),
          description: 'Runtime logs for generation and billing functions.',
        },
        {
          label: 'API settings',
          href: supabaseLink('/settings/api', 'https://supabase.com/dashboard'),
          description: 'Project URL and server-side API key management.',
        },
      ],
    },
    {
      title: 'Vercel',
      links: [
        {
          label: 'Admin project',
          href: vercelProjectLink(process.env.ADMIN_VERCEL_PROJECT),
          description: 'Deployments, domains, logs, and environment variables.',
        },
        {
          label: 'Customer app project',
          href: vercelProjectLink(process.env.APP_VERCEL_PROJECT),
          description: 'Main Vite app deployments and production domain.',
        },
        {
          label: 'Vercel dashboard',
          href: 'https://vercel.com/dashboard',
          description: 'All projects, domains, teams, and deployments.',
        },
      ],
    },
    {
      title: 'API providers',
      links: [
        {
          label: 'OpenRouter usage',
          href: 'https://openrouter.ai/activity',
          description: 'Parametric/CAD request activity and spend.',
        },
        {
          label: 'OpenRouter keys',
          href: 'https://openrouter.ai/settings/keys',
          description: 'API key management for routed calls.',
        },
        {
          label: 'Anthropic console',
          href: 'https://console.anthropic.com/',
          description: 'Direct API usage, keys, billing, and limits.',
        },
        {
          label: 'OpenAI usage',
          href: 'https://platform.openai.com/usage',
          description: 'Image generation/API usage and cost tracking.',
        },
        {
          label: 'OpenAI keys',
          href: 'https://platform.openai.com/api-keys',
          description: 'API key management for image generation.',
        },
        {
          label: 'Google AI Studio',
          href: 'https://aistudio.google.com/',
          description: 'Image generation access and keys.',
        },
        {
          label: 'fal dashboard',
          href: 'https://fal.ai/dashboard',
          description: 'fal.ai usage, keys, and endpoints.',
        },
        {
          label: 'fal pricing',
          href: 'https://fal.ai/pricing',
          description: 'Current endpoint pricing for image and 3D providers.',
        },
        {
          label: 'Stripe dashboard',
          href: 'https://dashboard.stripe.com/',
          description: 'Customers, subscriptions, payments, and logs.',
        },
        {
          label: 'Stripe logs',
          href: 'https://dashboard.stripe.com/logs',
          description: 'Billing API requests and webhook debugging.',
        },
        {
          label: 'Sentry',
          href: 'https://sentry.io/',
          description: 'Client and Edge Function error monitoring.',
        },
        {
          label: 'PostHog',
          href: 'https://app.posthog.com/',
          description: 'Product analytics and session diagnostics.',
        },
      ],
    },
  ];
}
