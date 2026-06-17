create index if not exists idx_images_created
  on public.images (created_at);
create index if not exists idx_messages_conversation_created
  on public.messages (conversation_id, created_at);
create index if not exists idx_conversations_user_updated
  on public.conversations (user_id, updated_at desc);
create index if not exists idx_cad_jobs_conversation_created
  on public.cad_jobs (conversation_id, created_at desc);
create index if not exists idx_meshes_conversation_created
  on public.meshes (conversation_id, created_at desc);
create index if not exists idx_images_conversation_created
  on public.images (conversation_id, created_at desc);

create or replace function public.admin_recent_generations(p_limit int default 30)
returns table(
  kind text,
  id uuid,
  status text,
  created_at timestamptz,
  user_email text,
  title text
)
language sql
security definer
set search_path = public, auth
as $$
  select * from (
    (select 'cad'::text as kind, c.id, c.status::text, c.created_at, u.email, conv.title
       from cad_jobs c
       join auth.users u on u.id = c.user_id
       left join conversations conv on conv.id = c.conversation_id
      order by c.created_at desc
      limit p_limit)
    union all
    (select 'mesh'::text as kind, m.id, m.status::text, m.created_at, u.email, conv.title
       from meshes m
       join auth.users u on u.id = m.user_id
       left join conversations conv on conv.id = m.conversation_id
      order by m.created_at desc
      limit p_limit)
    union all
    (select 'image'::text as kind, i.id, i.status::text, i.created_at, u.email, conv.title
       from images i
       join auth.users u on u.id = i.user_id
       left join conversations conv on conv.id = i.conversation_id
      order by i.created_at desc
      limit p_limit)
  ) feed
  order by created_at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 200);
$$;

create or replace function public.admin_generations_page(
  p_search text default null,
  p_kind   text default null,
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
      p_search is null
      or btrim(p_search) = ''
      or f.email ilike '%' || p_search || '%'
      or f.conversation_title ilike '%' || p_search || '%'
      or f.prompt::text ilike '%' || p_search || '%'
      or f.id::text ilike '%' || p_search || '%'
      or f.conversation_id::text ilike '%' || p_search || '%'
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

create or replace function public.admin_user_generation_details(
  p_user_id uuid,
  p_limit   int default 50
)
returns table(
  kind            text,
  id              uuid,
  status          text,
  created_at      timestamptz,
  title           text,
  file_type       text,
  conversation_id uuid,
  prompt          jsonb,
  message_id      uuid,
  error           text
)
language sql
security definer
set search_path = public
as $$
  select * from (
    (select 'cad'::text as kind, c.id, c.status::text, c.created_at,
            conv.title, null::text as file_type, c.conversation_id, c.prompt,
            c.message_id, c.error
       from cad_jobs c
       left join conversations conv on conv.id = c.conversation_id
      where c.user_id = p_user_id
      order by c.created_at desc
      limit p_limit)
    union all
    (select 'mesh'::text as kind, m.id, m.status::text, m.created_at,
            conv.title, m.file_type::text, m.conversation_id, m.prompt,
            null::uuid as message_id, null::text as error
       from meshes m
       left join conversations conv on conv.id = m.conversation_id
      where m.user_id = p_user_id
      order by m.created_at desc
      limit p_limit)
    union all
    (select 'image'::text as kind, i.id, i.status::text, i.created_at,
            conv.title, null::text as file_type, i.conversation_id, i.prompt,
            null::uuid as message_id, null::text as error
       from images i
       left join conversations conv on conv.id = i.conversation_id
      where i.user_id = p_user_id
      order by i.created_at desc
      limit p_limit)
  ) feed
  order by created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function public.admin_user_conversations(
  p_user_id uuid,
  p_limit   int default 50
)
returns table(
  id                 uuid,
  title              text,
  type               text,
  privacy            text,
  created_at         timestamptz,
  updated_at         timestamptz,
  message_count      bigint,
  cad_jobs           bigint,
  meshes             bigint,
  images             bigint,
  latest_message_at  timestamptz,
  latest_user_prompt jsonb
)
language sql
security definer
set search_path = public
as $$
  select
    c.id,
    c.title,
    c.type::text,
    c.privacy::text,
    c.created_at,
    c.updated_at,
    (select count(*) from messages m where m.conversation_id = c.id) as message_count,
    (select count(*) from cad_jobs j where j.conversation_id = c.id) as cad_jobs,
    (select count(*) from meshes mh where mh.conversation_id = c.id) as meshes,
    (select count(*) from images im where im.conversation_id = c.id) as images,
    (select max(m.created_at) from messages m where m.conversation_id = c.id) as latest_message_at,
    (select m.content from messages m
      where m.conversation_id = c.id and m.role = 'user'
      order by m.created_at desc
      limit 1) as latest_user_prompt
  from conversations c
  where c.user_id = p_user_id
  order by coalesce(c.updated_at, c.created_at) desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function public.admin_conversation_detail(p_conversation_id uuid)
returns jsonb
language sql
security definer
set search_path = public, auth
as $$
  select jsonb_build_object(
    'conversation', (
      select jsonb_build_object(
        'id', c.id,
        'title', c.title,
        'type', c.type::text,
        'privacy', c.privacy::text,
        'created_at', c.created_at,
        'updated_at', c.updated_at,
        'user_id', c.user_id,
        'user_email', u.email,
        'settings', c.settings
      )
      from conversations c
      left join auth.users u on u.id = c.user_id
      where c.id = p_conversation_id
    ),
    'messages', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', m.id,
          'created_at', m.created_at,
          'role', m.role,
          'content', m.content,
          'rating', m.rating,
          'parent_message_id', m.parent_message_id
        )
        order by m.created_at asc
      )
      from messages m
      where m.conversation_id = p_conversation_id
    ), '[]'::jsonb),
    'generations', jsonb_build_object(
      'cad_jobs', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'kind', 'cad',
            'id', c.id,
            'status', c.status::text,
            'created_at', c.created_at,
            'prompt', c.prompt,
            'file_type', null,
            'message_id', c.message_id,
            'error', c.error
          )
          order by c.created_at desc
        )
        from cad_jobs c
        where c.conversation_id = p_conversation_id
      ), '[]'::jsonb),
      'meshes', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'kind', 'mesh',
            'id', m.id,
            'status', m.status::text,
            'created_at', m.created_at,
            'prompt', m.prompt,
            'file_type', m.file_type::text,
            'message_id', null,
            'error', null
          )
          order by m.created_at desc
        )
        from meshes m
        where m.conversation_id = p_conversation_id
      ), '[]'::jsonb),
      'images', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'kind', 'image',
            'id', i.id,
            'status', i.status::text,
            'created_at', i.created_at,
            'prompt', i.prompt,
            'file_type', null,
            'message_id', null,
            'error', null
          )
          order by i.created_at desc
        )
        from images i
        where i.conversation_id = p_conversation_id
      ), '[]'::jsonb)
    )
  );
$$;

revoke all on function public.admin_recent_generations(int) from public;
revoke all on function public.admin_generations_page(text, text, int, int) from public;
revoke all on function public.admin_user_generation_details(uuid, int) from public;
revoke all on function public.admin_user_conversations(uuid, int) from public;
revoke all on function public.admin_conversation_detail(uuid) from public;

grant execute on function public.admin_recent_generations(int) to service_role;
grant execute on function public.admin_generations_page(text, text, int, int) to service_role;
grant execute on function public.admin_user_generation_details(uuid, int) to service_role;
grant execute on function public.admin_user_conversations(uuid, int) to service_role;
grant execute on function public.admin_conversation_detail(uuid) to service_role;
