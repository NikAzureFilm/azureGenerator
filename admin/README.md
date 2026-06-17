# Adam Admin Dashboard

A standalone analytics dashboard for the AzureFilm / Adam text-to-CAD app.
Tracks **users**, **what they generate**, **revenue**, and **token costs**.

It is a separate Next.js (App Router) project that reads from the **same
Supabase project** as the main app, using the **service-role key server-side**
to aggregate across all users (the app's tables are protected by per-user RLS).
Deploy it as its **own Vercel project**.

## What it shows

- **Users** — total, new (7d / 30d), active (30d), paying subscribers, conversion.
- **Revenue** — MRR (Stripe live, or DB-derived from active subscriptions),
  token-pack revenue (lifetime + 30d), and actual cash collected from Stripe.
- **Token usage & cost** — tokens consumed (total / 30d), provider cost (COGS at
  $0.01/token), list value ($0.03/token), breakdown by operation, and
  outstanding token liability (unspent balances).
- **Generations** — CAD jobs (with success rate), meshes, images,
  conversations, messages, prompt-helper runs, a 30-day activity chart, a live
  feed of recent generations, and top users by token usage.

- **Generation explorer** - searchable CAD, mesh and image rows with stored
  prompt JSON, conversation links, and per-conversation message drilldowns.
- **Operations links** - live shortcuts for Supabase, Vercel, API providers,
  Stripe, Sentry, PostHog and production apps.

## 1. Install the database functions (one time)

The dashboard reads aggregates through a handful of `SECURITY DEFINER`
functions that are locked to the `service_role`. Apply them once:

```bash
# from the repo root, against the linked Supabase project
supabase db execute --file admin/sql/admin_metrics.sql
supabase db execute --file admin/sql/admin_explorer.sql
```

or paste both `admin/sql/admin_metrics.sql` and `admin/sql/admin_explorer.sql`
into the Supabase SQL editor and run them. Re-running is safe. (`admin_explorer.sql`
also creates supporting indexes — on a hot production DB, run its
`create index` lines individually `WITH CONCURRENTLY`.)

> The actual-cost panels (the **Costs** page and the Overview "Provider cost" /
> "Gross margin" cards) additionally need the `provider_usage` table from the
> main app migration `supabase/migrations/20260608120000_provider_usage.sql`
> applied, and the edge functions redeployed so they record real provider cost.
> Until then the dashboard transparently falls back to the $0.01/token estimate.

## 2. Local development

```bash
cd admin
cp .env.local.example .env.local   # fill in the values
npm install
npm run dev                        # http://localhost:3000
```

Get the keys from **Supabase → Project Settings → API**:

- `SUPABASE_URL` — project URL
- `SUPABASE_ANON_KEY` — anon/publishable key (used only to validate admin logins)
- `SUPABASE_SERVICE_ROLE_KEY` — **secret**, server-side only
- `ADMIN_EMAILS` — comma-separated allowlist of admin emails
- `STRIPE_SECRET_KEY` — optional; enables real revenue panels

Sign in with a Supabase user whose email is in `ADMIN_EMAILS` (the user must
already exist in Supabase Auth — create one in the Supabase dashboard if needed).

## 3. Deploy to Vercel (new project)

1. Push this repo to GitHub (the admin app lives in `admin/`).
2. In Vercel, **New Project** → import the repo.
3. Set **Root Directory** to `admin`.
4. Framework preset: **Next.js** (auto-detected).
5. Add the environment variables from step 2 under **Settings → Environment
   Variables** (all environments). Do **not** add a `NEXT_PUBLIC_` prefix —
   these must stay server-side.
6. Deploy. You'll get a new URL, e.g. `https://adam-admin.vercel.app`.

### Security notes

- The service-role key bypasses RLS and is only ever used in server code
  (`lib/supabaseAdmin.ts`, route handlers, server components). It is never sent
  to the browser.
- The page is gated by Supabase login + the `ADMIN_EMAILS` allowlist; non-admin
  sign-ins are rejected before a session cookie is issued.
- `robots` is set to `noindex`. Consider also enabling Vercel password
  protection on the project for defense in depth.

## Keeping pricing in sync

`lib/pricing.ts` vendors the cost constants (`$0.01` COGS, `$0.03` list value)
and plan prices from the main app's `shared/tokenCosts.ts` /
`shared/pricingCatalog.ts`. The DB-derived MRR in `admin/sql/admin_metrics.sql`
also hardcodes plan prices. If plan prices change in the main app, update both.
