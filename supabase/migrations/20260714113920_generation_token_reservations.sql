-- Reserve generation credits without deducting them. Long-running CAD and mesh
-- jobs only settle the reservation after a usable model has been persisted.
-- If an Edge Function is killed, the reservation expires and the user was
-- never charged.

create table public.generation_token_reservations (
  reference_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  operation public.token_operation_type not null,
  tokens integer not null check (tokens > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'settling', 'charged', 'released')),
  reserved_until timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  charged_at timestamptz,
  check (char_length(reference_id) between 1 and 200)
);

create index generation_token_reservations_user_active_idx
  on public.generation_token_reservations (user_id, reserved_until)
  where status in ('reserved', 'settling');

alter table public.generation_token_reservations enable row level security;

revoke all on table public.generation_token_reservations from public, anon, authenticated;
grant all on table public.generation_token_reservations to service_role;

create or replace function public.reserve_generation_tokens(
  p_user_id uuid,
  p_reference_id text,
  p_operation public.token_operation_type,
  p_tokens integer,
  p_available_tokens integer,
  p_ttl_seconds integer default 21600
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.generation_token_reservations%rowtype;
  v_reserved integer;
begin
  if p_user_id is null
    or p_reference_id is null
    or btrim(p_reference_id) = ''
    or p_tokens <= 0
    or p_available_tokens < 0
    or p_ttl_seconds < 60
    or p_ttl_seconds > 86400
  then
    raise exception 'invalid generation token reservation';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 0)
  );

  select *
    into v_existing
    from public.generation_token_reservations
   where reference_id = p_reference_id
   for update;

  if found and v_existing.user_id <> p_user_id then
    raise exception 'generation token reservation belongs to another user';
  end if;

  if found and v_existing.status = 'charged' then
    return jsonb_build_object(
      'success', true,
      'status', 'charged',
      'tokensReserved', v_existing.tokens,
      'tokensAvailable', p_available_tokens
    );
  end if;

  select coalesce(sum(tokens), 0)::integer
    into v_reserved
    from public.generation_token_reservations
   where user_id = p_user_id
     and reference_id <> p_reference_id
     and status in ('reserved', 'settling')
     and reserved_until > now();

  if v_reserved + p_tokens > p_available_tokens then
    return jsonb_build_object(
      'success', false,
      'reason', 'insufficient_tokens',
      'tokensRequired', p_tokens,
      'tokensAvailable', greatest(p_available_tokens - v_reserved, 0),
      'tokensReserved', v_reserved
    );
  end if;

  insert into public.generation_token_reservations (
    reference_id,
    user_id,
    operation,
    tokens,
    status,
    reserved_until,
    updated_at,
    charged_at
  ) values (
    p_reference_id,
    p_user_id,
    p_operation,
    p_tokens,
    'reserved',
    now() + make_interval(secs => p_ttl_seconds),
    now(),
    null
  )
  on conflict (reference_id) do update
    set operation = excluded.operation,
        tokens = excluded.tokens,
        status = 'reserved',
        reserved_until = excluded.reserved_until,
        updated_at = now(),
        charged_at = null
    where public.generation_token_reservations.user_id = excluded.user_id
      and public.generation_token_reservations.status <> 'charged';

  return jsonb_build_object(
    'success', true,
    'status', 'reserved',
    'tokensReserved', p_tokens,
    'tokensAvailable', p_available_tokens - v_reserved
  );
end;
$$;

create or replace function public.claim_generation_token_reservation(
  p_user_id uuid,
  p_reference_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reservation public.generation_token_reservations%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 0)
  );

  select *
    into v_reservation
    from public.generation_token_reservations
   where reference_id = p_reference_id
     and user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('status', 'missing');
  end if;

  if v_reservation.status = 'charged' then
    return jsonb_build_object(
      'status', 'already_charged',
      'tokens', v_reservation.tokens,
      'operation', v_reservation.operation::text
    );
  end if;

  if v_reservation.status = 'released' then
    return jsonb_build_object('status', 'released');
  end if;

  if v_reservation.status = 'settling'
     and v_reservation.updated_at > now() - interval '2 minutes'
  then
    return jsonb_build_object('status', 'settlement_in_progress');
  end if;

  update public.generation_token_reservations
     set status = 'settling', updated_at = now()
   where reference_id = p_reference_id;

  return jsonb_build_object(
    'status', 'claimed',
    'tokens', v_reservation.tokens,
    'operation', v_reservation.operation::text
  );
end;
$$;

create or replace function public.release_generation_token_reservation(
  p_user_id uuid,
  p_reference_id text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reservation public.generation_token_reservations%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 0)
  );

  select *
    into v_reservation
    from public.generation_token_reservations
   where reference_id = p_reference_id
     and user_id = p_user_id
   for update;

  if not found then
    return 'missing';
  end if;

  if v_reservation.status = 'charged' then
    return 'charged';
  end if;

  if v_reservation.status = 'released' then
    return 'already_released';
  end if;

  -- A duplicate callback must not release a reservation while the first
  -- callback is actively settling its charge. A stale settlement can be
  -- released safely and retried as a fresh generation.
  if v_reservation.status = 'settling'
     and v_reservation.updated_at > now() - interval '2 minutes'
  then
    return 'settlement_in_progress';
  end if;

  update public.generation_token_reservations
     set status = 'released', updated_at = now()
   where reference_id = p_reference_id;

  return 'released';
end;
$$;

revoke all on function public.reserve_generation_tokens(uuid, text, public.token_operation_type, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_generation_token_reservation(uuid, text) from public, anon, authenticated;
revoke all on function public.release_generation_token_reservation(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_generation_tokens(uuid, text, public.token_operation_type, integer, integer, integer) to service_role;
grant execute on function public.claim_generation_token_reservation(uuid, text) to service_role;
grant execute on function public.release_generation_token_reservation(uuid, text) to service_role;
