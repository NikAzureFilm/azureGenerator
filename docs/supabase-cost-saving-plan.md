# Supabase Cost Saving Plan

## Goal

Keep Supabase and storage infrastructure predictable for 100-999 users, with a target of roughly $30-$150 per month for Supabase and R2 infrastructure before AI provider costs, Vercel, Stripe fees, and domain/email tools.

This plan keeps Supabase as the system of record and moves high-egress generated assets to cheaper object storage.

## Recommended Stack

- Supabase: Auth, Postgres, RLS, metadata, token ledger, subscriptions, admin analytics.
- Cloudflare R2: generated images, previews, meshes, CAD artifacts, and temporary multiview files.
- Supabase Storage: avatars, tiny profile assets, and short-term fallback only.

Cloudflare R2 is the preferred external storage layer because it is S3-compatible and has no internet egress fees. Supabase remains the right place for relational data, auth, security policies, and reporting.

## Main Cost Risks

For hundreds of users, the most likely cost drivers are:

- Edge Function invocations from frequent polling.
- Storage egress from generated images, GLBs, STLs, previews, and CAD artifacts.
- Realtime message volume and peak connections.
- Oversized database compute.
- Add-ons such as PITR, log drains, preview branches, read replicas, extra IOPS, and custom domains.

Supabase Spend Cap protects many surprise usage categories, but not compute, branching compute, read replica compute, custom domains, log drain hours/events, PITR, IPv4, extra disk IOPS, or extra disk throughput.

Source: https://supabase.com/docs/guides/platform/cost-control

## Phase 1: Immediate Fixes

### 1. Reduce billing-status polling

The app currently polls `billing-status` every 30 seconds in `src/contexts/AuthProvider.tsx`. This can become expensive as active users grow.

Replace it with:

- Fetch once on login/session refresh.
- Refetch after checkout, token purchase, generation completion, refund, or subscription status change.
- Use a fallback interval of 5-15 minutes, not 30 seconds.
- Avoid polling while the tab is hidden.

Rough impact:

- 500 active users online 2 hours/day at 30-second polling: about 3.6M calls/month.
- 500 active users online 2 hours/day at 10-minute polling: about 180k calls/month.

This is the highest-priority engineering cost fix.

### 2. Poll pending messages only during active jobs

Any pending-message polling should run only while a generation is active and stop immediately after `success` or `failure`.

Rules:

- No global background polling.
- No polling on inactive history/share pages.
- Use realtime or explicit mutation responses for final status where possible.
- Add a timeout/backoff for long-running jobs.

### 3. Keep Supabase Spend Cap on

Keep Spend Cap enabled until there is a deliberate decision to exceed included quotas. If the cap is turned off, review the upcoming invoice at least weekly.

### 4. Start with small compute

Use the smallest compute size that passes load tests. Supabase compute is charged hourly and is not covered by Spend Cap.

Suggested default:

- Early production: Small compute.
- Upgrade to Medium only after load tests or dashboard metrics show CPU, memory, or query latency need it.
- Do not upgrade compute to hide slow queries; fix indexes and query shape first.

Source: https://supabase.com/docs/guides/platform/manage-your-usage/compute

## Phase 2: Product Limits

Enforce cost controls at the product layer. These limits must be checked server-side, not only in the UI.

| Limit                   |    Free / Trial |            Paid |
| ----------------------- | --------------: | --------------: |
| Active generations      |               1 |             2-3 |
| Daily generations       | Fixed small cap |  Plan-based cap |
| Upload size             |        10-25 MB |       50-100 MB |
| Stored generated assets |          Capped |      Higher cap |
| Temp files              | Expire in hours | Expire in hours |
| Failed job artifacts    |  Delete quickly |  Delete quickly |
| Retries                 |         Limited |         Limited |

Recommended implementation points:

- Enforce generation limits before token deduction.
- Enforce upload size before issuing signed upload URLs.
- Store per-user storage usage in metadata or aggregate it periodically.
- Delete temp objects on a schedule.
- Mark abandoned uploads and cleanup after 24 hours.

## Phase 3: Storage Architecture

Move heavy generated objects to Cloudflare R2.

Objects to move:

- `images`
- `meshes`
- `previews`
- `cad-artifacts`
- `temp-multiview`

Keep metadata in Supabase:

```sql
create table generation_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  conversation_id uuid,
  kind text not null,
  provider text not null default 'r2',
  bucket text not null,
  object_key text not null,
  mime_type text,
  size_bytes bigint not null default 0,
  visibility text not null default 'private',
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  deleted_at timestamptz
);
```

Access flow:

1. Client asks backend for an upload or download URL.
2. Backend checks Supabase auth, ownership, conversation visibility, plan limits, and upload size.
3. Backend returns a signed R2 URL.
4. Client uploads/downloads directly against R2.
5. Backend writes or updates Supabase metadata.
6. Public share pages use short-lived signed URLs or controlled public preview objects.

Do not make generated-asset buckets broadly public. Public access should be explicit and limited to share-safe derived previews.

Storage optimization rules:

- Generate thumbnails/previews separately from full assets.
- Compress generated preview images.
- Use immutable object keys and long cache lifetimes for public derived assets.
- Delete failed-job assets quickly.
- Delete temp multiview files within hours.
- Keep original large files only for paid users or recent generations.
- Add lifecycle rules in R2 for temporary paths.

Sources:

- https://developers.cloudflare.com/r2/pricing/
- https://supabase.com/docs/guides/storage/production/scaling

## Phase 4: Realtime Rules

Realtime should be scoped tightly.

Use:

- One channel per active user/job.
- Status updates only: `pending`, selected progress milestones, `success`, `failure`.
- Small payloads.
- Aggressive unsubscribe after completion.

Avoid:

- Global generation channels.
- High-frequency progress ticks.
- Broadcasting large payloads.
- Keeping idle channels open.
- Realtime for historical lists where normal queries are enough.

Supabase bills Realtime by message volume and peak connections.

Source: https://supabase.com/docs/guides/realtime/pricing

## Phase 5: Database Cost Discipline

Before traffic grows:

- Index `user_id`, `conversation_id`, `created_at`, `status`, and `reference_id`.
- Index columns used in RLS predicates.
- Avoid `select('*')` in list views.
- Paginate history and messages.
- Keep provider usage logs append-only, but archive old rows later.
- Use summary tables or materialized views for admin charts.
- Run Supabase Performance Advisor monthly.
- Load test before upgrading compute.

For admin analytics:

- Prefer aggregated SQL functions for dashboards.
- Avoid heavy full-table scans on every admin page load.
- Cache expensive retention/cohort results.
- Use date ranges by default.

## Monthly Budget Targets

These targets exclude AI provider costs.

| Stage      | Setup                                               | Expected infra budget |
| ---------- | --------------------------------------------------- | --------------------: |
| Early 100s | Supabase Pro + Small compute + R2                   |         $30-$60/month |
| Mid 100s   | Supabase Small/Medium + R2 + Spend Cap on           |        $50-$120/month |
| High 100s  | Medium compute if needed + R2 + possible PITR later |      $100-$200+/month |

AI generation providers may dominate total cost. Track provider cost separately from Supabase infrastructure.

## Monthly Review Checklist

Review these weekly during launch, then monthly:

- Supabase usage page.
- Upcoming invoice.
- Edge Function invocations.
- Realtime peak connections.
- Realtime message volume.
- Storage egress.
- Top storage objects by download count.
- DB CPU and memory.
- Slow queries.
- Active users vs paying users.
- Storage per user.
- Cost per generation.
- AI provider cost per generation.

## Add-on Policy

Do not enable these without a specific reason and a budget owner:

- Read replicas.
- PITR.
- Log drains.
- Preview branches.
- Extra disk IOPS.
- Extra disk throughput.
- Larger compute.
- Public buckets for generated assets.
- Custom domains on Supabase.

## Implementation Priority

1. Reduce `billing-status` polling.
2. Stop pending-message polling when no active generation exists.
3. Add server-side generation, upload, and retry limits.
4. Add generated-asset metadata table.
5. Move generated assets to R2 behind signed URLs.
6. Add temp-object cleanup.
7. Add storage usage tracking per user.
8. Review indexes and RLS predicate performance.
9. Add monthly cost dashboard metrics in the admin app.

## Success Criteria

The plan is working when:

- Supabase Edge Function invocations grow roughly with real actions, not idle sessions.
- Storage egress does not grow linearly with repeated asset views.
- Realtime messages only occur during active workflows.
- Database compute remains Small or Medium through hundreds of users.
- Free/trial users cannot create unbounded storage or generation costs.
- Admin dashboards show cost per generation and cost per active user.
