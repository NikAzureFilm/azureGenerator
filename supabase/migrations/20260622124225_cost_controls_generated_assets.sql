-- Cost-control foundation for generated assets and high-volume generation
-- queries. Supabase remains the system of record; generated_assets is the
-- metadata layer that lets generated files move from Supabase Storage to R2
-- without broad public buckets.

do $$
begin
  alter type public."stripe-level" add value if not exists 'max';
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter type public.subscription_level add value if not exists 'max';
exception
  when duplicate_object then null;
end $$;

create table if not exists public.generation_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on update cascade on delete cascade,
  conversation_id uuid references public.conversations(id) on update cascade on delete cascade,
  source_table text,
  source_id uuid,
  kind text not null,
  provider text not null default 'r2',
  bucket text not null,
  object_key text not null,
  mime_type text,
  size_bytes bigint not null default 0,
  visibility text not null default 'private',
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  deleted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  constraint generation_assets_size_bytes_check check (size_bytes >= 0),
  constraint generation_assets_kind_check check (
    kind in (
      'image',
      'mesh',
      'preview',
      'cad-artifact',
      'temp-multiview',
      'failed-artifact'
    )
  ),
  constraint generation_assets_provider_check check (
    provider in ('r2', 'supabase')
  ),
  constraint generation_assets_visibility_check check (
    visibility in ('private', 'public')
  ),
  constraint generation_assets_source_table_check check (
    source_table is null
    or source_table in ('images', 'meshes', 'previews', 'cad_jobs')
  )
);

create or replace function public.get_subscription_token_limit(p_user_id uuid)
returns integer
language plpgsql
stable
as $$
declare
  userlevel public.subscriptions.level%type;
  userstatus public.subscriptions.status%type;
begin
  select status, level into userstatus, userlevel
  from public.subscriptions
  where user_id = p_user_id;

  if userstatus = 'active' or userstatus = 'trialing' then
    if userlevel = 'max' then
      return 50000;
    elsif userlevel = 'pro' then
      return 5000;
    elsif userlevel = 'standard' then
      return 1000;
    end if;
  end if;

  return 0;
end;
$$;

alter table public.generation_assets enable row level security;

create unique index if not exists generation_assets_active_object_key_idx
  on public.generation_assets (provider, bucket, object_key)
  where deleted_at is null;

create index if not exists generation_assets_user_created_idx
  on public.generation_assets (user_id, created_at desc)
  where deleted_at is null;

create index if not exists generation_assets_conversation_created_idx
  on public.generation_assets (conversation_id, created_at desc)
  where deleted_at is null;

create index if not exists generation_assets_source_idx
  on public.generation_assets (source_table, source_id, created_at desc)
  where deleted_at is null;

create index if not exists generation_assets_kind_created_idx
  on public.generation_assets (kind, created_at desc)
  where deleted_at is null;

create index if not exists generation_assets_expiry_idx
  on public.generation_assets (expires_at)
  where deleted_at is null and expires_at is not null;

drop policy if exists "Users can manage their generated assets"
  on public.generation_assets;
create policy "Users can manage their generated assets"
on public.generation_assets
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Public can read shared generated assets"
  on public.generation_assets;
create policy "Public can read shared generated assets"
on public.generation_assets
for select
to anon, authenticated
using (
  visibility = 'public'
  or exists (
    select 1
    from public.conversations
    where conversations.id = generation_assets.conversation_id
      and conversations.privacy = 'public'::public.privacy_type
  )
);

grant select, insert, update, delete on table public.generation_assets
  to authenticated;
grant select on table public.generation_assets to anon;
grant all on table public.generation_assets to service_role;

create or replace view public.generation_asset_usage as
select
  user_id,
  count(*)::bigint as asset_count,
  coalesce(sum(size_bytes), 0)::bigint as storage_bytes,
  coalesce(sum(size_bytes) filter (where provider = 'r2'), 0)::bigint
    as r2_storage_bytes,
  coalesce(sum(size_bytes) filter (where provider = 'supabase'), 0)::bigint
    as supabase_storage_bytes,
  coalesce(sum(size_bytes) filter (where kind = 'temp-multiview'), 0)::bigint
    as temp_storage_bytes,
  max(created_at) as latest_asset_at
from public.generation_assets
where deleted_at is null
group by user_id;

revoke all on table public.generation_asset_usage from anon, authenticated;
grant select on table public.generation_asset_usage to service_role;

create or replace function public.cleanup_expired_generation_assets(
  p_now timestamptz default now()
)
returns table(marked_deleted bigint, deleted_supabase_objects bigint)
language sql
security definer
set search_path = public, storage
as $$
  with expired as (
    select id, provider, bucket, object_key
    from public.generation_assets
    where deleted_at is null
      and (
        expires_at <= p_now
        or (kind = 'temp-multiview' and created_at < p_now - interval '6 hours')
        or (kind = 'failed-artifact' and created_at < p_now - interval '6 hours')
      )
  ),
  deleted_storage as (
    delete from storage.objects o
    using expired e
    where e.provider = 'supabase'
      and o.bucket_id = e.bucket
      and o.name = e.object_key
    returning o.id
  ),
  marked as (
    update public.generation_assets ga
    set deleted_at = p_now
    from expired e
    where ga.id = e.id
    returning ga.id
  )
  select
    (select count(*) from marked)::bigint as marked_deleted,
    (select count(*) from deleted_storage)::bigint
      as deleted_supabase_objects;
$$;

revoke all on function public.cleanup_expired_generation_assets(timestamptz)
  from public;
grant execute on function public.cleanup_expired_generation_assets(timestamptz)
  to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (
      select 1 from cron.job where jobname = 'cleanup-expired-generation-assets'
    ) then
      perform cron.unschedule('cleanup-expired-generation-assets');
    end if;

    perform cron.schedule(
      'cleanup-expired-generation-assets',
      '37 * * * *',
      'select public.cleanup_expired_generation_assets();'
    );
  end if;
exception
  when undefined_table or undefined_function or insufficient_privilege then
    null;
end $$;

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('images', 'images', false, 104857600),
  ('meshes', 'meshes', false, 104857600),
  ('previews', 'previews', false, 104857600),
  ('cad-artifacts', 'cad-artifacts', false, 104857600),
  ('temp-multiview', 'temp-multiview', false, 26214400)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

-- Query and RLS predicate indexes for generation workflows and dashboards.
create index if not exists idx_images_user_created
  on public.images (user_id, created_at desc);
create index if not exists idx_images_conversation_created
  on public.images (conversation_id, created_at desc);
create index if not exists idx_images_status_created
  on public.images (status, created_at desc);
create index if not exists idx_images_user_status_created
  on public.images (user_id, status, created_at desc);

create index if not exists idx_meshes_user_created
  on public.meshes (user_id, created_at desc);
create index if not exists idx_meshes_conversation_created
  on public.meshes (conversation_id, created_at desc);
create index if not exists idx_meshes_status_created
  on public.meshes (status, created_at desc);
create index if not exists idx_meshes_user_status_created
  on public.meshes (user_id, status, created_at desc);

create index if not exists idx_previews_user_created
  on public.previews (user_id, created_at desc);
create index if not exists idx_previews_conversation_created
  on public.previews (conversation_id, created_at desc);
create index if not exists idx_previews_mesh_status_updated
  on public.previews (mesh_id, status, updated_at desc);
create index if not exists idx_previews_status_created
  on public.previews (status, created_at desc);

create index if not exists idx_cad_jobs_user_created
  on public.cad_jobs (user_id, created_at desc);
create index if not exists idx_cad_jobs_user_status_created
  on public.cad_jobs (user_id, status, created_at desc);
create index if not exists idx_cad_jobs_conversation_created
  on public.cad_jobs (conversation_id, created_at desc);
create index if not exists idx_cad_jobs_status_created
  on public.cad_jobs (status, created_at desc);
create index if not exists idx_cad_jobs_worker_request_id
  on public.cad_jobs (worker_request_id)
  where worker_request_id is not null;

create index if not exists idx_token_transactions_user_operation_created
  on public.token_transactions (user_id, operation, created_at desc);
create index if not exists idx_token_transactions_reference_id
  on public.token_transactions (reference_id)
  where reference_id is not null;

create index if not exists idx_provider_usage_conversation_created
  on public.provider_usage (conversation_id, created_at desc)
  where conversation_id is not null;
create index if not exists idx_provider_usage_status_created
  on public.provider_usage (status, created_at desc);
