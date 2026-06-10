-- Patch: admin_generations_page gains a p_status filter and matches user_id
-- in search. Paste this whole file into the Supabase SQL editor and run it.
--
-- Until this is applied, the deployed dashboard still works: unfiltered views
-- use the old 4-arg function, and status-filtered views fall back to direct
-- queries (slower, capped at ~500 rows). The canonical definition lives in
-- admin/sql/admin_explorer.sql; this file is just the delta for the live DB.

-- The original signature had no p_status; drop it so the new definition does
-- not become an ambiguous overload (PostgREST refuses ambiguous RPC calls).
drop function if exists public.admin_generations_page(text, text, int, int);

create or replace function public.admin_generations_page(
  p_search text default null,
  p_kind   text default null,
  p_status text default null,
  p_limit  int  default 50,
  p_offset int  default 0
)
returns table(
  kind               text,
  id                 uuid,
  status             text,
  created_at         timestamptz,
  user_id            uuid,
  email              text,
  conversation_id    uuid,
  conversation_title text,
  conversation_type  text,
  prompt             jsonb,
  file_type          text,
  message_id         uuid,
  error              text,
  total_count        bigint
)
language sql
security definer
set search_path = public, auth
as $$
  with feed as (
    select
      'cad'::text as kind,
      c.id,
      c.status::text as status,
      c.created_at,
      c.user_id,
      u.email::text as email,
      c.conversation_id,
      conv.title as conversation_title,
      conv.type::text as conversation_type,
      c.prompt,
      null::text as file_type,
      c.message_id,
      c.error
    from cad_jobs c
    join auth.users u on u.id = c.user_id
    left join conversations conv on conv.id = c.conversation_id

    union all

    select
      'mesh'::text as kind,
      m.id,
      m.status::text as status,
      m.created_at,
      m.user_id,
      u.email::text as email,
      m.conversation_id,
      conv.title as conversation_title,
      conv.type::text as conversation_type,
      m.prompt,
      m.file_type::text as file_type,
      null::uuid as message_id,
      null::text as error
    from meshes m
    join auth.users u on u.id = m.user_id
    left join conversations conv on conv.id = m.conversation_id

    union all

    select
      'image'::text as kind,
      i.id,
      i.status::text as status,
      i.created_at,
      i.user_id,
      u.email::text as email,
      i.conversation_id,
      conv.title as conversation_title,
      conv.type::text as conversation_type,
      i.prompt,
      null::text as file_type,
      null::uuid as message_id,
      null::text as error
    from images i
    join auth.users u on u.id = i.user_id
    left join conversations conv on conv.id = i.conversation_id
  ),
  filtered as (
    select *
    from feed f
    where (
      p_kind is null
      or btrim(p_kind) = ''
      or lower(p_kind) = 'all'
      or f.kind = lower(p_kind)
    )
    and (
      p_status is null
      or btrim(p_status) = ''
      or lower(p_status) = 'all'
      or f.status = lower(p_status)
    )
    and (
      p_search is null
      or btrim(p_search) = ''
      or f.email ilike '%' || p_search || '%'
      or f.conversation_title ilike '%' || p_search || '%'
      or f.prompt::text ilike '%' || p_search || '%'
      or f.id::text ilike '%' || p_search || '%'
      or f.conversation_id::text ilike '%' || p_search || '%'
      or f.user_id::text ilike '%' || p_search || '%'
    )
  )
  select
    f.kind,
    f.id,
    f.status,
    f.created_at,
    f.user_id,
    f.email,
    f.conversation_id,
    f.conversation_title,
    f.conversation_type,
    f.prompt,
    f.file_type,
    f.message_id,
    f.error,
    count(*) over() as total_count
  from filtered f
  order by f.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.admin_generations_page(text, text, text, int, int) from public;
grant execute on function public.admin_generations_page(text, text, text, int, int) to service_role;
