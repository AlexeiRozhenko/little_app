-- =====================================================================
-- SAME PAGE — database schema for Supabase
-- Run once: Supabase Dashboard → SQL Editor → paste this file → Run.
-- Safe to re-run (uses IF NOT EXISTS / ON CONFLICT).
--
-- Security model (simple and strict):
--   * RLS is ENABLED on every table and there are NO policies,
--     so the browser (anon / authenticated keys) can read NOTHING directly.
--   * All data goes through the Python backend, which uses the
--     service-role key and enforces membership + reveal rules.
--   * The storage bucket is private; photos are served via short-lived
--     signed URLs only when the viewer is allowed to see them.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- tables ----------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.rooms (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default 'Our page',
  timezone   text not null default 'Asia/Almaty',
  status     text not null default 'pending' check (status in ('pending','active','archived')),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_members (
  id        uuid primary key default gen_random_uuid(),
  room_id   uuid not null references public.rooms(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'member' check (role in ('owner','member')),
  is_active boolean not null default true,
  joined_at timestamptz not null default now(),
  unique (room_id, user_id)
);
-- MVP: a user belongs to at most one active room
create unique index if not exists room_members_one_active_room
  on public.room_members(user_id) where is_active;
create index if not exists room_members_room_idx on public.room_members(room_id);

create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  token       text not null unique,
  created_by  uuid not null references auth.users(id) on delete cascade,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.questions (
  id          uuid primary key default gen_random_uuid(),
  text        text not null unique,
  description text,
  category    text not null,
  depth       text not null check (depth in ('light','medium','deep')),
  language    text not null default 'en',
  tags        text[] not null default '{}',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.daily_sessions (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  question_id  uuid not null references public.questions(id),
  session_date date not null,
  status       text not null default 'open' check (status in ('open','revealed')),
  reveal_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (room_id, session_date)          -- one question per room per day
);
create index if not exists daily_sessions_room_status_idx on public.daily_sessions(room_id, status);

create table if not exists public.answers (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.daily_sessions(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  text_content text,
  status       text not null default 'draft' check (status in ('draft','submitted')),
  submitted_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (session_id, user_id)
);

create table if not exists public.answer_media (
  id           uuid primary key default gen_random_uuid(),
  answer_id    uuid not null references public.answers(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  media_type   text not null default 'image' check (media_type in ('image','audio')),
  storage_path text not null,
  caption      text,
  file_size    bigint not null,
  mime_type    text not null,
  created_at   timestamptz not null default now()
);
create index if not exists answer_media_answer_idx on public.answer_media(answer_id);

create table if not exists public.emotional_checkins (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.daily_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  stage      text not null check (stage in ('initial_reaction','during_answering','after_reading')),
  emotions   text[] not null default '{}',
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, user_id, stage)
);

create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.daily_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  content    text not null,
  created_at timestamptz not null default now()
);
create index if not exists comments_session_idx on public.comments(session_id);

create table if not exists public.reactions (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.daily_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  unique (session_id, user_id, emoji)
);

-- XP is granted only by the backend; the unique key makes farming impossible
create table if not exists public.xp_events (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  event_type   text not null,
  reference_id uuid not null,
  points       integer not null,
  created_at   timestamptz not null default now(),
  unique (user_id, event_type, reference_id)
);
create index if not exists xp_events_room_idx on public.xp_events(room_id);

-- ---------- lock everything down -------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','rooms','room_members','invitations','questions','daily_sessions',
    'answers','answer_media','emotional_checkins','comments','reactions','xp_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ---------- atomic business logic ------------------------------------

-- Get today's session for a room, creating it exactly once.
create or replace function public.get_or_create_daily_session(p_room_id uuid, p_date date)
returns setof public.daily_sessions
language plpgsql
set search_path = public
as $$
declare v_q uuid;
begin
  if not exists (select 1 from daily_sessions where room_id = p_room_id and session_date = p_date) then
    -- prefer a question this room has not seen yet
    select q.id into v_q
      from questions q
     where q.is_active
       and not exists (select 1 from daily_sessions d where d.room_id = p_room_id and d.question_id = q.id)
     order by random()
     limit 1;
    if v_q is null then  -- pool exhausted: start repeating
      select id into v_q from questions where is_active order by random() limit 1;
    end if;
    if v_q is null then
      raise exception 'NO_QUESTIONS';
    end if;
    insert into daily_sessions(room_id, question_id, session_date)
    values (p_room_id, v_q, p_date)
    on conflict (room_id, session_date) do nothing;   -- concurrent request won? fine.
  end if;
  return query select * from daily_sessions where room_id = p_room_id and session_date = p_date;
end $$;

-- Join a room by invitation token. Enforces "max two members" under a row lock.
create or replace function public.join_room(p_token text, p_user_id uuid)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_inv   invitations;
  v_count int;
begin
  select * into v_inv from invitations where token = p_token for update;
  if not found then raise exception 'INVALID_INVITE'; end if;

  perform 1 from rooms where id = v_inv.room_id for update;   -- serialize joins

  if exists (select 1 from room_members where room_id = v_inv.room_id and user_id = p_user_id and is_active) then
    return v_inv.room_id;                                      -- already here
  end if;
  if v_inv.expires_at < now() then raise exception 'INVITE_EXPIRED'; end if;
  if exists (select 1 from room_members where user_id = p_user_id and is_active) then
    raise exception 'ALREADY_IN_ROOM';
  end if;

  select count(*) into v_count from room_members where room_id = v_inv.room_id and is_active;
  if v_count >= 2 then raise exception 'ROOM_FULL'; end if;

  insert into room_members(room_id, user_id, role) values (v_inv.room_id, p_user_id, 'member');
  update invitations set accepted_at = now(), accepted_by = p_user_id where id = v_inv.id;
  update rooms set status = 'active', updated_at = now() where id = v_inv.room_id;
  return v_inv.room_id;
end $$;

-- Lock an answer and reveal the day if both people have submitted.
create or replace function public.submit_answer(p_session_id uuid, p_user_id uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_cnt    int;
  v_status text;
begin
  perform 1 from daily_sessions where id = p_session_id for update;  -- serialize submits

  update answers
     set status = 'submitted', submitted_at = now(), updated_at = now()
   where session_id = p_session_id and user_id = p_user_id and status = 'draft';
  if not found then raise exception 'ALREADY_SUBMITTED'; end if;

  select count(*) into v_cnt from answers where session_id = p_session_id and status = 'submitted';
  if v_cnt >= 2 then
    update daily_sessions
       set status = 'revealed', reveal_at = now(), updated_at = now()
     where id = p_session_id and status = 'open';
  end if;

  select status into v_status from daily_sessions where id = p_session_id;
  return v_status;
end $$;

-- only the backend (service_role) may call these
revoke execute on function public.get_or_create_daily_session(uuid, date) from public, anon, authenticated;
revoke execute on function public.join_room(text, uuid)                   from public, anon, authenticated;
revoke execute on function public.submit_answer(uuid, uuid)               from public, anon, authenticated;
grant  execute on function public.get_or_create_daily_session(uuid, date) to service_role;
grant  execute on function public.join_room(text, uuid)                   to service_role;
grant  execute on function public.submit_answer(uuid, uuid)               to service_role;

-- ---------- private storage bucket -----------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('answer-media', 'answer-media', false, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- ---------- seed questions -------------------------------------------

insert into public.questions (text, description, category, depth) values
  ('What is your most unnecessary talent?', 'Everyone has one. Show off.', 'Random', 'light'),
  ('What would your perfect lazy Sunday look like?', null, 'Daily Life', 'light'),
  ('What smell instantly takes you back to childhood?', null, 'Childhood', 'light'),
  ('What did you eat today that you would recommend?', null, 'Daily Life', 'light'),
  ('If you could add one holiday to the calendar, what would it celebrate?', null, 'What If', 'light'),
  ('What is the best thing you saw outside today?', 'A photo answer works great here.', 'Our World', 'light'),
  ('Which cartoon or book character did you want to be as a kid?', null, 'Childhood', 'light'),
  ('If you had a free plane ticket for tomorrow, where would you go?', null, 'Dreams', 'light'),
  ('What song is stuck in your head lately?', null, 'Random', 'light'),
  ('What tiny thing made you smile this week?', null, 'Daily Life', 'light'),
  ('What is something you have changed your mind about recently?', null, 'Philosophy', 'medium'),
  ('What makes you feel most understood?', null, 'Friendship', 'medium'),
  ('What is something you wish you could experience again for the first time?', null, 'Dreams', 'medium'),
  ('What habit would future you thank you for starting now?', null, 'Future Me', 'medium'),
  ('What is a memory of us that you think about more than I would guess?', null, 'Friendship', 'medium'),
  ('Which rule from your childhood home do you still follow?', null, 'Childhood', 'medium'),
  ('If you could live one year in any decade, which would you pick and why?', null, 'What If', 'medium'),
  ('What does a really good day look like for you right now?', null, 'Daily Life', 'medium'),
  ('What is something people often get wrong about where you live?', null, 'Our World', 'medium'),
  ('Where do you see yourself living in five years — and is it different from what you would have said a year ago?', null, 'Future Me', 'medium'),
  ('What is a small risk you are glad you took?', null, 'Deep Talks', 'medium'),
  ('What would you do with one extra hour every day?', null, 'What If', 'light'),
  ('What is something you rarely tell people about yourself?', 'Only share what feels right.', 'Deep Talks', 'deep'),
  ('When do you feel most like yourself?', null, 'Deep Talks', 'deep'),
  ('What is a fear you have quietly outgrown?', null, 'Deep Talks', 'deep'),
  ('What do you think a good life actually is?', null, 'Philosophy', 'deep'),
  ('What is something you needed to hear as a kid?', null, 'Childhood', 'deep'),
  ('What do you hope never changes about our friendship?', null, 'Friendship', 'deep'),
  ('What would you tell yourself from ten years ago?', null, 'Future Me', 'deep'),
  ('What dream have you put on pause, and what would it take to restart it?', null, 'Dreams', 'deep')
on conflict (text) do nothing;
