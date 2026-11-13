-- Prophet Kevin Online — Supabase schema
-- Everything the app and the creator dashboard need: content, media registry,
-- members, comments, Amens, live chat, settings, and the security rules around them.
--
-- Security model
--   * Reads of published content go through get_bundle() and friends (security definer).
--   * Every write goes through an RPC below that checks who is calling
--     (auth.uid(), is_admin()) — tables have RLS on and no write policies.
--   * Files live in the public "media" storage bucket; only the media team can
--     upload/replace/delete, members may upload a testimony video into their own folder.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 60),
  phone text check (phone is null or phone ~ '^\+?[0-9]{6,16}$'),
  banned boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.items (
  id text primary key,
  collection text not null check (collection in ('posts','broadcasts','books','albums','events','testimonies','photos','schedule')),
  status text not null default 'published' check (status in ('published','draft','pending','rejected')),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  sort double precision not null default 0,
  member_id uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index items_coll_idx on public.items (collection, status, published_at desc);

create table public.media (
  id text primary key,                  -- object path inside the "media" bucket
  mime text not null,
  kind text not null check (kind in ('image','video','audio','file')),
  size bigint not null default 0,
  original_name text not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.amens (
  target text not null,
  actor uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (target, actor)
);
create index amens_target_idx on public.amens (target);

create table public.comments (
  id text primary key,
  target text not null,
  member_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  body text not null check (char_length(body) between 1 and 1000),
  parent_id text references public.comments(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index comments_target_idx on public.comments (target, created_at);

create table public.chat (
  id bigserial primary key,
  member_id uuid references auth.users(id) on delete set null,
  name text not null,
  body text not null check (char_length(body) <= 300),
  is_mod boolean not null default false,
  deleted boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.rate_events (
  key text not null,
  at timestamptz not null default now()
);
create index rate_events_idx on public.rate_events (key, at);

-- ---------------------------------------------------------------- row level security

alter table public.admins enable row level security;
alter table public.profiles enable row level security;
alter table public.items enable row level security;
alter table public.media enable row level security;
alter table public.amens enable row level security;
alter table public.comments enable row level security;
alter table public.chat enable row level security;
alter table public.settings enable row level security;
alter table public.rate_events enable row level security;

-- Live chat and live/settings rows are readable so Realtime can deliver changes.
-- Removed chat messages keep their row (for the "delete" event) but lose their text.
create policy chat_read on public.chat for select using (true);
create policy settings_read on public.settings for select using (true);
create policy items_read on public.items for select using (status = 'published' and published_at <= now());
create policy comments_read on public.comments for select using (true);
create policy profiles_own on public.profiles for select using (user_id = auth.uid());
create policy amens_own on public.amens for select using (actor = auth.uid());

-- ---------------------------------------------------------------- helpers

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public._require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Please sign in to the dashboard' using errcode = '42501';
  end if;
end $$;

create or replace function public._fail(msg text, details jsonb default null, code text default '22023') returns void
language plpgsql as $$
begin
  raise exception '%', msg using errcode = code, detail = coalesce(details::text, '');
end $$;

/** Sliding-window rate limit: raises after `max` events for `key` within `win`. */
create or replace function public._rate_limit(k text, max integer, win interval) returns void
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  select count(*) into n from public.rate_events where key = k and at > now() - win;
  if n >= max then
    raise exception 'Too many requests — please wait a moment and try again' using errcode = 'PT429';
  end if;
  insert into public.rate_events (key) values (k);
  if random() < 0.01 then delete from public.rate_events where at < now() - interval '1 day'; end if;
end $$;

create or replace function public._new_id(prefix text) returns text
language sql volatile as $$
  select prefix || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
$$;

create or replace function public._member() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles;
begin
  if auth.uid() is null then perform public._fail('Please sign in first', null, '42501'); end if;
  select * into p from public.profiles where user_id = auth.uid();
  if not found then perform public._fail('Please sign in first', null, '42501'); end if;
  if p.banned then perform public._fail('Your account cannot post right now. Contact the media team.', null, '42501'); end if;
  return p;
end $$;

create or replace function public._item_json(i public.items, with_meta boolean default false) returns jsonb
language sql stable as $$
  select i.data || jsonb_build_object('id', i.id, 'publishedAt', i.published_at)
    || case when with_meta then jsonb_build_object('status', i.status, 'sort', i.sort, 'createdAt', i.created_at, 'updatedAt', i.updated_at, 'memberId', i.member_id) else '{}'::jsonb end;
$$;

-- Defaults for settings, merged with whatever the media team saved.
create or replace function public._settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'appName','Prophet Kevin Online','ministry','Apostolic Gospel Mission','tvName','Transfiguration TV',
    'recordsName','Transfiguration Records','leader','Prophet Kevin',
    'aboutText','The ministry of Prophet Kevin. Home of Transfiguration TV and Transfiguration Records.',
    'aboutVerse','','aboutVerseRef','','logo',null,'leaderPhoto',null)
  || coalesce((select value from public.settings where key = 'app'), '{}'::jsonb);
$$;
create or replace function public._live() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('onAir', false, 'title', 'Live service', 'ref', '', 'video', null, 'url', '', 'poster', null,
    'timezone', 'Africa/Douala', 'channel24', true, 'autoOnAir', true, 'autoArchive', true, 'archiveCategory', 'Services',
    'status', null, 'statusAt', null, 'programme', null)
  || coalesce((select value from public.settings where key = 'live'), '{}'::jsonb);
$$;

-- ---------------------------------------------------------------- content validation (server side)
-- The dashboard validates every field from the shared schema; this is the backstop:
-- required fields, value shapes, and that referenced files exist.

create or replace function public._required_fields(coll text) returns text[]
language sql immutable as $$
  select case coll
    when 'posts' then array['title','flair','body']
    when 'broadcasts' then array['title','category','poster']
    when 'books' then array['title','description','image']
    when 'albums' then array['title','artist','image']
    when 'events' then array['title','date','time','place','description']
    when 'testimonies' then array['title','name','body']
    when 'photos' then array['image','caption','album']
    when 'schedule' then array['time','title']
  end;
$$;

create or replace function public._media_fields(coll text) returns text[]
language sql immutable as $$
  select case coll
    when 'posts' then array['image'] when 'broadcasts' then array['video','poster'] when 'books' then array['image','pdf']
    when 'albums' then array['image'] when 'events' then array['image'] when 'testimonies' then array['video']
    when 'photos' then array['image'] else array[]::text[] end;
$$;

create or replace function public._validate_item(coll text, d jsonb) returns void
language plpgsql stable security definer set search_path = public as $$
declare errs jsonb := '{}'::jsonb; f text; v jsonb; i integer; row jsonb;
begin
  if public._required_fields(coll) is null then perform public._fail('Unknown content type', null, 'PT404'); end if;
  foreach f in array public._required_fields(coll) loop
    v := d -> f;
    if v is null or v = 'null'::jsonb or v = '""'::jsonb or v = '[]'::jsonb then
      errs := errs || jsonb_build_object(f, initcap(f) || ' is required');
    end if;
  end loop;
  foreach f in array public._media_fields(coll) loop
    v := d -> f;
    -- Broadcast thumbnails may be a link (recordings from the streaming service).
    if coll = 'broadcasts' and f = 'poster' and v #>> '{}' ~ '^https://\S+$' then continue; end if;
    if v is not null and jsonb_typeof(v) = 'string' and v #>> '{}' <> '' and not exists (select 1 from public.media where id = v #>> '{}') then
      errs := errs || jsonb_build_object(f, 'File was not found — upload it again');
    end if;
  end loop;
  if d ? 'body' and d -> 'body' <> 'null'::jsonb and jsonb_typeof(d -> 'body') <> 'array' then errs := errs || '{"body":"Body must be a list of paragraphs"}'; end if;
  if coll = 'schedule' then
    if (d ->> 'time') !~ '^([01]\d|2[0-3]):[0-5]\d$' then errs := errs || '{"time":"Use a 24-hour time like 18:30"}'; end if;
    if coalesce(d ->> 'end', '') <> '' and (d ->> 'end') !~ '^([01]\d|2[0-3]):[0-5]\d$' then errs := errs || '{"end":"Use a 24-hour time like 20:00"}'; end if;
    if coalesce(d ->> 'days', 'Every day') <> all (array['Every day','Weekdays','Weekends','Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays','Sundays']) then errs := errs || '{"days":"Choose which days it airs"}'; end if;
    if coalesce(d ->> 'source', 'Live from the studio') <> all (array['Live from the studio','A past message','Latest messages on rotation']) then errs := errs || '{"source":"Choose what plays"}'; end if;
    if d ->> 'source' = 'A past message' and not exists (select 1 from public.items b where b.collection = 'broadcasts' and b.id = d ->> 'broadcast') then
      errs := errs || '{"broadcast":"Choose the past message to play"}';
    end if;
  end if;
  if coll = 'broadcasts' and coalesce(d ->> 'duration', '') <> '' and (jsonb_typeof(d -> 'duration') <> 'number' or (d ->> 'duration')::numeric <= 0) then
    errs := errs || '{"duration":"Length must be a number of seconds"}';
  end if;
  if coll = 'events' and d ? 'date' and (d ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' then errs := errs || '{"date":"Date must be YYYY-MM-DD"}'; end if;
  if coll = 'albums' and jsonb_typeof(d -> 'tracks') = 'array' then
    for i in 0 .. jsonb_array_length(d -> 'tracks') - 1 loop
      row := d -> 'tracks' -> i;
      if coalesce(row ->> 'title', '') = '' then errs := errs || jsonb_build_object('tracks.' || i || '.title', 'Track ' || (i + 1) || ': Song title is required'); end if;
      if coalesce(row ->> 'audio', '') <> '' and not exists (select 1 from public.media where id = row ->> 'audio') then
        errs := errs || jsonb_build_object('tracks.' || i || '.audio', 'Track ' || (i + 1) || ': audio file was not found');
      end if;
    end loop;
  end if;
  if coll = 'books' and jsonb_typeof(d -> 'chapters') = 'array' then
    for i in 0 .. jsonb_array_length(d -> 'chapters') - 1 loop
      row := d -> 'chapters' -> i;
      if coalesce(row ->> 'title', '') = '' then errs := errs || jsonb_build_object('chapters.' || i || '.title', 'Chapter ' || (i + 1) || ': title is required'); end if;
    end loop;
  end if;
  if errs <> '{}'::jsonb then perform public._fail('Please fix the highlighted fields', errs); end if;
end $$;

/** Give list rows (tracks, chapters) stable ids. */
create or replace function public._with_row_ids(d jsonb) returns jsonb
language plpgsql volatile as $$
declare k text; arr jsonb; out jsonb; i integer; r jsonb;
begin
  foreach k in array array['tracks','chapters'] loop
    arr := d -> k;
    if jsonb_typeof(arr) = 'array' then
      out := '[]'::jsonb;
      for i in 0 .. jsonb_array_length(arr) - 1 loop
        r := arr -> i;
        if coalesce(r ->> 'id', '') !~ '^[A-Za-z0-9-]{1,40}$' then r := r || jsonb_build_object('id', left(k, 2) || i || '-' || substr(md5(random()::text), 1, 6)); end if;
        out := out || jsonb_build_array(r);
      end loop;
      d := d || jsonb_build_object(k, out);
    end if;
  end loop;
  return d;
end $$;

-- ---------------------------------------------------------------- public reads

/** Everything the app shows, in one call. Book chapter text is fetched per chapter. */
create or replace function public.get_bundle() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb; c text; ord text;
begin
  out := jsonb_build_object('settings', public._settings(), 'live', public._live());
  foreach c in array array['posts','broadcasts','books','albums','events','testimonies','photos','schedule'] loop
    out := out || jsonb_build_object(c, coalesce((
      select jsonb_agg(
        case when c = 'books' then public._item_json(i) || jsonb_build_object('chapters', coalesce((
            select jsonb_agg(jsonb_build_object('id', ch ->> 'id', 'title', ch ->> 'title',
              'words', coalesce(array_length(regexp_split_to_array(trim(coalesce((select string_agg(p, ' ') from jsonb_array_elements_text(ch -> 'body') p), '')), '\s+'), 1), 0)))
            from jsonb_array_elements(i.data -> 'chapters') ch), '[]'::jsonb))
        else public._item_json(i) end
        order by
          case when c = 'events' then i.data ->> 'date' end asc,
          case when c in ('books','schedule') then i.sort end asc,
          case when c not in ('events','books','schedule') then i.published_at end desc,
          i.created_at asc)
      from public.items i
      where i.collection = c and i.status = 'published' and i.published_at <= now()), '[]'::jsonb));
  end loop;
  out := out || jsonb_build_object(
    'amens', coalesce((select jsonb_object_agg(target, n) from (select target, count(*) n from public.amens group by target) a), '{}'::jsonb),
    'comments', coalesce((select jsonb_object_agg(target, n) from (select target, count(*) n from public.comments group by target) a), '{}'::jsonb),
    'version', extract(epoch from greatest(
      (select max(updated_at) from public.items), (select max(updated_at) from public.settings), 'epoch'::timestamptz))::bigint,
    'generatedAt', now());
  return out;
end $$;

create or replace function public.get_chapter(p_book text, p_chapter text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare chs jsonb; i integer;
begin
  select data -> 'chapters' into chs from public.items where id = p_book and collection = 'books' and status = 'published' and published_at <= now();
  if chs is null then perform public._fail('Book not found', null, 'PT404'); end if;
  for i in 0 .. jsonb_array_length(chs) - 1 loop
    if chs -> i ->> 'id' = p_chapter then return (chs -> i) || jsonb_build_object('index', i); end if;
  end loop;
  perform public._fail('Chapter not found', null, 'PT404');
end $$;

create or replace function public.get_comments(p_target text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'body', c.body, 'parentId', c.parent_id,
    'createdAt', c.created_at, 'memberId', c.member_id, 'amens', (select count(*) from public.amens a where a.target = c.id)) order by c.created_at), '[]'::jsonb)
  from (select * from public.comments where target = p_target order by created_at limit 500) c;
$$;

create or replace function public.my_amens() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(target), '[]'::jsonb) from public.amens where actor = auth.uid();
$$;

create or replace function public.get_live() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('live', public._live(), 'messages', coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'body', body, 'isMod', is_mod, 'createdAt', created_at) order by id)
    from (select * from public.chat where not deleted order by id desc limit 40) m), '[]'::jsonb));
$$;

create or replace function public.get_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('settings', public._settings(), 'live', public._live());
$$;

-- ---------------------------------------------------------------- member actions

create or replace function public.set_profile(p_name text, p_phone text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n text := regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'); ph text := nullif(regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g'), '');
begin
  if auth.uid() is null then perform public._fail('Please sign in first', null, '42501'); end if;
  n := trim(n);
  if char_length(n) < 2 then perform public._fail('Please enter your name'); end if;
  if char_length(n) > 60 then perform public._fail('Name must be 60 characters or fewer'); end if;
  if ph is not null and ph !~ '^\+?[0-9]{6,16}$' then perform public._fail('Please enter a valid phone number'); end if;
  insert into public.profiles (user_id, name, phone) values (auth.uid(), n, ph)
    on conflict (user_id) do update set name = excluded.name, phone = coalesce(excluded.phone, public.profiles.phone);
  return jsonb_build_object('id', auth.uid(), 'name', n);
end $$;

create or replace function public.get_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', user_id, 'name', name) from public.profiles where user_id = auth.uid();
$$;

create or replace function public.toggle_amen(p_target text, p_on boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare had boolean; want boolean; n integer;
begin
  if auth.uid() is null then perform public._fail('Please sign in first', null, '42501'); end if;
  if p_target !~ '^[A-Za-z0-9_:-]{1,80}$' and p_target !~ '^gallery:[\w ''&.-]{1,80}$' then perform public._fail('Invalid target'); end if;
  if not (p_target = 'live' or p_target like 'gallery:%'
          or exists (select 1 from public.items where id = p_target and status = 'published')
          or exists (select 1 from public.comments where id = p_target)) then
    perform public._fail('Post not found', null, 'PT404');
  end if;
  perform public._rate_limit('amen:' || auth.uid(), 120, interval '1 minute');
  had := exists (select 1 from public.amens where target = p_target and actor = auth.uid());
  want := coalesce(p_on, not had);
  if want and not had then insert into public.amens (target, actor) values (p_target, auth.uid()); end if;
  if not want and had then delete from public.amens where target = p_target and actor = auth.uid(); end if;
  select count(*) into n from public.amens where target = p_target;
  return jsonb_build_object('target', p_target, 'on', want, 'count', n);
end $$;

create or replace function public.post_comment(p_target text, p_body text, p_parent text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.profiles := public._member(); b text := trim(coalesce(p_body, '')); par text; c public.comments;
begin
  perform public._rate_limit('comment:' || m.user_id, 12, interval '1 minute');
  if not exists (select 1 from public.items where id = p_target and status = 'published') then perform public._fail('Post not found', null, 'PT404'); end if;
  if b = '' then perform public._fail('Comment is empty'); end if;
  if char_length(b) > 1000 then perform public._fail('Comments can be up to 1000 characters'); end if;
  if p_parent is not null then
    select coalesce(parent_id, id) into par from public.comments where id = p_parent and target = p_target;
    if par is null then perform public._fail('The comment you replied to was removed', null, 'PT404'); end if;
  end if;
  insert into public.comments (id, target, member_id, name, body, parent_id)
    values (public._new_id('c'), p_target, m.user_id, m.name, b, par) returning * into c;
  return jsonb_build_object('id', c.id, 'name', c.name, 'body', c.body, 'parentId', c.parent_id, 'createdAt', c.created_at, 'memberId', c.member_id, 'amens', 0);
end $$;

create or replace function public.delete_comment(p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  delete from public.comments where id = p_id and member_id = auth.uid();
  if not found then perform public._fail('Comment not found', null, 'PT404'); end if;
  return '{"ok":true}';
end $$;

create or replace function public.submit_testimony(p_title text, p_body text, p_place text default null, p_name text default null, p_video text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.profiles := public._member(); paras jsonb; v_id text;
begin
  perform public._rate_limit('testimony:' || m.user_id, 5, interval '1 hour');
  if char_length(trim(coalesce(p_title, ''))) = 0 then perform public._fail('Please fix the highlighted fields', '{"title":"Title is required"}'); end if;
  if char_length(trim(coalesce(p_title, ''))) > 140 then perform public._fail('Please fix the highlighted fields', '{"title":"Title must be 140 characters or fewer"}'); end if;
  if char_length(trim(coalesce(p_body, ''))) < 20 then perform public._fail('Please fix the highlighted fields', '{"body":"Tell your story in a few sentences"}'); end if;
  if char_length(p_body) > 20000 then perform public._fail('Please fix the highlighted fields', '{"body":"Story is too long"}'); end if;
  if p_video is not null and not exists (select 1 from public.media where id = p_video and kind = 'video' and uploaded_by = m.user_id) then
    perform public._fail('Video upload not found');
  end if;
  select coalesce(jsonb_agg(trim(regexp_replace(p, '\s*\n\s*', ' ', 'g'))) filter (where trim(p) <> ''), '[]'::jsonb) into paras
    from regexp_split_to_table(p_body, '\n\s*\n') p;
  v_id := public._new_id('te');
  insert into public.items (id, collection, status, data, member_id) values (v_id, 'testimonies', 'pending', jsonb_build_object(
    'title', left(trim(p_title), 140), 'name', left(coalesce(nullif(trim(p_name), ''), m.name), 80), 'place', nullif(left(trim(coalesce(p_place, '')), 80), ''),
    'quote', left(substring(trim(p_body) from '^[^.!?]*[.!?]?'), 280), 'body', paras, 'video', p_video), m.user_id);
  return jsonb_build_object('id', v_id, 'status', 'pending');
end $$;

/** Members register the testimony video they uploaded to media/members/<uid>/… */
create or replace function public.register_member_upload(p_path text, p_mime text, p_size bigint, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.profiles := public._member();
begin
  perform public._rate_limit('upload:' || m.user_id, 6, interval '1 hour');
  if p_path !~ ('^members/' || m.user_id || '/[A-Za-z0-9_.-]{1,120}$') then perform public._fail('Invalid upload path'); end if;
  if p_mime !~ '^video/' then perform public._fail('Please choose a video file'); end if;
  insert into public.media (id, mime, kind, size, original_name, uploaded_by) values (p_path, p_mime, 'video', coalesce(p_size, 0), left(coalesce(p_name, 'video'), 120), m.user_id)
    on conflict (id) do nothing;
  return jsonb_build_object('id', p_path);
end $$;

create or replace function public.post_chat(p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.profiles := public._member(); b text := trim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g')); r public.chat;
begin
  perform public._rate_limit('chat:' || m.user_id, 8, interval '20 seconds');
  if b = '' then perform public._fail('Message is empty'); end if;
  if char_length(b) > 300 then perform public._fail('Messages can be up to 300 characters'); end if;
  insert into public.chat (member_id, name, body) values (m.user_id, m.name, b) returning * into r;
  return jsonb_build_object('id', r.id, 'name', r.name, 'body', r.body, 'isMod', r.is_mod, 'createdAt', r.created_at);
end $$;

-- ---------------------------------------------------------------- dashboard: accounts

/** The very first person to sign up on the dashboard becomes its admin. */
create or replace function public.claim_first_admin(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare em text;
begin
  select email into em from auth.users where id = auth.uid();
  if em is null then perform public._fail('Sign in with an email first', null, '42501'); end if;
  perform pg_advisory_xact_lock(4242);
  if exists (select 1 from public.admins) then perform public._fail('The dashboard already has an owner. Ask them to give you access.', null, '42501'); end if;
  insert into public.admins (user_id, email, name) values (auth.uid(), em, coalesce(nullif(trim(p_name), ''), split_part(em, '@', 1)));
  return jsonb_build_object('id', auth.uid(), 'email', em, 'name', coalesce(nullif(trim(p_name), ''), split_part(em, '@', 1)));
end $$;

create or replace function public.admin_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', user_id, 'email', email, 'name', name) from public.admins where user_id = auth.uid();
$$;

create or replace function public.dashboard_has_owner() returns boolean
language sql stable security definer set search_path = public as $$ select exists (select 1 from public.admins); $$;

create or replace function public.admin_team() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', user_id, 'email', email, 'name', name, 'created_at', created_at) order by created_at) from public.admins), '[]'::jsonb);
end $$;

/** Give dashboard access to someone who has already created an account with this email. */
create or replace function public.admin_grant(p_email text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; em text := lower(trim(coalesce(p_email, '')));
begin
  perform public._require_admin();
  select id into uid from auth.users where lower(email) = em;
  if uid is null then perform public._fail('No account with that email yet. Ask them to open the dashboard and choose "Create an account" first.', null, 'PT404'); end if;
  if exists (select 1 from public.admins where user_id = uid) then perform public._fail('That person already has access', null, '23505'); end if;
  insert into public.admins (user_id, email, name) values (uid, em, coalesce(nullif(trim(p_name), ''), split_part(em, '@', 1)));
  return jsonb_build_object('id', uid, 'email', em);
end $$;

create or replace function public.admin_revoke(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  if p_user = auth.uid() then perform public._fail('You can''t remove yourself'); end if;
  delete from public.admins where user_id = p_user;
  if not found then perform public._fail('Not found', null, 'PT404'); end if;
  return '{"ok":true}';
end $$;

-- ---------------------------------------------------------------- dashboard: content

create or replace function public.admin_list(p_collection text, p_status text default 'all') returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  if public._required_fields(p_collection) is null then perform public._fail('Unknown content type', null, 'PT404'); end if;
  return coalesce((select jsonb_agg(public._item_json(i, true)
      || jsonb_build_object('amens', (select count(*) from public.amens a where a.target = i.id), 'commentCount', (select count(*) from public.comments c where c.target = i.id))
      order by
        case when p_collection = 'events' then i.data ->> 'date' end asc,
        case when p_collection in ('books','schedule') then i.sort end asc,
        case when p_collection not in ('events','books','schedule') then i.published_at end desc,
        i.created_at asc)
    from public.items i where i.collection = p_collection and (p_status = 'all' or i.status = p_status)), '[]'::jsonb);
end $$;

create or replace function public.admin_get(p_collection text, p_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i public.items;
begin
  perform public._require_admin();
  select * into i from public.items where id = p_id and collection = p_collection;
  if not found then perform public._fail('Not found', null, 'PT404'); end if;
  return public._item_json(i, true) || jsonb_build_object('amens', (select count(*) from public.amens a where a.target = i.id));
end $$;

/** Create (p_id null) or update an item. Partial updates merge into the stored data. */
create or replace function public.admin_save(p_collection text, p_id text, p_data jsonb, p_status text default null, p_published_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur public.items; d jsonb; st text; pub timestamptz; i public.items;
begin
  perform public._require_admin();
  if public._required_fields(p_collection) is null then perform public._fail('Unknown content type', null, 'PT404'); end if;
  if p_status is not null and p_status not in ('published','draft','pending','rejected') then perform public._fail('Invalid status'); end if;
  if p_id is not null then
    select * into cur from public.items where id = p_id and collection = p_collection for update;
    if not found then perform public._fail('Not found', null, 'PT404'); end if;
  end if;
  d := public._with_row_ids(coalesce(cur.data, '{}'::jsonb) || coalesce(p_data, '{}'::jsonb));
  perform public._validate_item(p_collection, d);
  st := coalesce(p_status, cur.status, 'published');
  pub := coalesce(p_published_at, cur.published_at, now());
  if p_id is null then
    insert into public.items (id, collection, status, data, sort, published_at)
      values (public._new_id(left(p_collection, 2)), p_collection, st, d,
              coalesce((select max(sort) from public.items where collection = p_collection), 0) + 1, pub)
      returning * into i;
  else
    update public.items set data = d, status = st, published_at = pub, updated_at = now() where id = p_id returning * into i;
  end if;
  return public._item_json(i, true);
end $$;

create or replace function public.admin_delete(p_collection text, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  delete from public.items where id = p_id and collection = p_collection;
  if not found then perform public._fail('Not found', null, 'PT404'); end if;
  delete from public.comments where target = p_id;
  delete from public.amens where target = p_id;
  return '{"ok":true}';
end $$;

create or replace function public.admin_reorder(p_collection text, p_ids text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k integer;
begin
  perform public._require_admin();
  for k in 1 .. coalesce(array_length(p_ids, 1), 0) loop
    update public.items set sort = k, updated_at = now() where collection = p_collection and id = p_ids[k];
  end loop;
  return '{"ok":true}';
end $$;

create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare wk timestamptz := now() - interval '7 days';
begin
  perform public._require_admin();
  return jsonb_build_object(
    'items', coalesce((select jsonb_object_agg(collection, s) from (select collection, jsonb_object_agg(status, n) s from (select collection, status, count(*) n from public.items group by 1, 2) a group by collection) b), '{}'::jsonb),
    'members', (select count(*) from public.profiles), 'membersWeek', (select count(*) from public.profiles where created_at > wk),
    'amens', (select count(*) from public.amens), 'amensWeek', (select count(*) from public.amens where created_at > wk),
    'comments', (select count(*) from public.comments), 'commentsWeek', (select count(*) from public.comments where created_at > wk),
    'pendingTestimonies', (select count(*) from public.items where collection = 'testimonies' and status = 'pending'),
    'media', jsonb_build_object('n', (select count(*) from public.media), 'bytes', (select coalesce(sum(size), 0) from public.media)),
    'onAir', coalesce((public._live() ->> 'onAir')::boolean, false),
    'top', coalesce((select jsonb_agg(t) from (
      select jsonb_build_object('id', i.id, 'collection', i.collection, 'title', coalesce(i.data ->> 'title', i.data ->> 'caption'), 'amens', count(*)) t
      from public.amens a join public.items i on i.id = a.target group by i.id order by count(*) desc limit 5) x), '[]'::jsonb));
end $$;

create or replace function public.admin_save_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare merged jsonb := public._settings() || coalesce(p, '{}'::jsonb); k text; errs jsonb := '{}';
begin
  perform public._require_admin();
  foreach k in array array['appName','ministry','tvName','recordsName','leader'] loop
    if coalesce(trim(merged ->> k), '') = '' then errs := errs || jsonb_build_object(k, 'This field is required'); end if;
  end loop;
  foreach k in array array['logo','leaderPhoto'] loop
    if coalesce(merged ->> k, '') <> '' and not exists (select 1 from public.media where id = merged ->> k) then errs := errs || jsonb_build_object(k, 'File was not found'); end if;
  end loop;
  if errs <> '{}'::jsonb then perform public._fail('Please fix the highlighted fields', errs); end if;
  insert into public.settings (key, value) values ('app', merged) on conflict (key) do update set value = excluded.value, updated_at = now();
  return merged;
end $$;

create or replace function public.admin_save_live(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare merged jsonb := public._live() || coalesce(p, '{}'::jsonb); errs jsonb := '{}';
begin
  perform public._require_admin();
  if coalesce(trim(merged ->> 'title'), '') = '' then errs := errs || '{"title":"Service title is required"}'; end if;
  if coalesce(merged ->> 'poster', '') = '' then errs := errs || '{"poster":"Poster image is required"}'; end if;
  if (merged ->> 'onAir')::boolean and coalesce(merged ->> 'video', '') = '' and coalesce(merged ->> 'url', '') = '' then errs := errs || '{"video":"Add a stream file or URL before going live"}'; end if;
  if coalesce(merged ->> 'url', '') <> '' and merged ->> 'url' !~ '^https://' then errs := errs || '{"url":"Use an https:// link"}'; end if;
  if not exists (select 1 from pg_timezone_names where name = merged ->> 'timezone') then errs := errs || '{"timezone":"Use a time zone name like Africa/Douala"}'; end if;
  if coalesce(trim(merged ->> 'archiveCategory'), '') = '' then errs := errs || '{"archiveCategory":"Category is required"}'; end if;
  if errs <> '{}'::jsonb then perform public._fail('Please fix the highlighted fields', errs); end if;
  insert into public.settings (key, value) values ('live', merged) on conflict (key) do update set value = excluded.value, updated_at = now();
  return merged;
end $$;

-- ---------------------------------------------------------------- dashboard: media registry

create or replace function public.admin_register_media(p_id text, p_mime text, p_size bigint, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text := case when p_mime like 'image/%' then 'image' when p_mime like 'video/%' then 'video' when p_mime like 'audio/%' then 'audio' when p_mime = 'application/pdf' then 'file' end;
declare r public.media;
begin
  perform public._require_admin();
  if k is null then perform public._fail('This file type isn''t supported'); end if;
  if p_id !~ '^[A-Za-z0-9_./-]{1,200}$' or p_id like '%..%' then perform public._fail('Invalid file path'); end if;
  insert into public.media (id, mime, kind, size, original_name, uploaded_by) values (p_id, p_mime, k, coalesce(p_size, 0), left(coalesce(p_name, p_id), 120), auth.uid())
    on conflict (id) do update set mime = excluded.mime, kind = excluded.kind, size = excluded.size, original_name = excluded.original_name
    returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.admin_list_media(p_kind text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at desc) from public.media m where p_kind is null or m.kind = p_kind), '[]'::jsonb);
end $$;

create or replace function public.admin_media_usage(p_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb := '[]';
begin
  perform public._require_admin();
  select coalesce(jsonb_agg(initcap(rtrim(i.collection, 's')) || ': ' || coalesce(i.data ->> 'title', i.data ->> 'caption', i.id)), '[]') into out
    from public.items i where i.data::text like '%"' || p_id || '"%';
  if public._settings()::text like '%"' || p_id || '"%' then out := out || '["App settings"]'; end if;
  if public._live()::text like '%"' || p_id || '"%' then out := out || '["Live stream"]'; end if;
  return out;
end $$;

/** Removes the registry row; the dashboard then deletes the stored object. */
create or replace function public.admin_delete_media(p_id text, p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare used jsonb := public.admin_media_usage(p_id);
begin
  if jsonb_array_length(used) > 0 and not p_force then perform public._fail('This file is still used by: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(used) x), jsonb_build_object('usedBy', used), '23503'); end if;
  delete from public.media where id = p_id;
  if not found then perform public._fail('File not found', null, 'PT404'); end if;
  return '{"ok":true}';
end $$;

-- ---------------------------------------------------------------- dashboard: moderation

create or replace function public.admin_comments(p_q text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'target', c.target, 'name', c.name, 'body', c.body, 'memberId', c.member_id, 'createdAt', c.created_at,
      'on', coalesce(initcap(rtrim(i.collection, 's')) || ': ' || coalesce(i.data ->> 'title', i.data ->> 'caption'), c.target)) order by c.created_at desc)
    from (select * from public.comments where coalesce(p_q, '') = '' or body ilike '%' || p_q || '%' or name ilike '%' || p_q || '%' order by created_at desc limit 300) c
    left join public.items i on i.id = c.target), '[]'::jsonb);
end $$;

create or replace function public.admin_delete_comment(p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  delete from public.comments where id = p_id;
  if not found then perform public._fail('Comment not found', null, 'PT404'); end if;
  return '{"ok":true}';
end $$;

create or replace function public.admin_chat_post(p_body text, p_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b text := trim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g')); r public.chat;
begin
  perform public._require_admin();
  if b = '' then perform public._fail('Message is empty'); end if;
  if char_length(b) > 300 then perform public._fail('Messages can be up to 300 characters'); end if;
  insert into public.chat (member_id, name, body, is_mod)
    values (auth.uid(), coalesce(nullif(left(trim(coalesce(p_name, '')), 60), ''), (select name from public.admins where user_id = auth.uid())), b, true) returning * into r;
  return jsonb_build_object('id', r.id, 'name', r.name, 'body', r.body, 'isMod', r.is_mod, 'createdAt', r.created_at);
end $$;

create or replace function public.admin_chat_delete(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  update public.chat set deleted = true, body = '' where id = p_id and not deleted;
  if not found then perform public._fail('Message not found', null, 'PT404'); end if;
  return '{"ok":true}';
end $$;

create or replace function public.admin_members() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.user_id, 'name', p.name, 'phone', p.phone, 'banned', p.banned, 'created_at', p.created_at,
      'comments', (select count(*) from public.comments c where c.member_id = p.user_id)) order by p.created_at desc)
    from public.profiles p), '[]'::jsonb);
end $$;

create or replace function public.admin_ban(p_user uuid, p_banned boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  update public.profiles set banned = p_banned where user_id = p_user;
  if not found then perform public._fail('Member not found', null, 'PT404'); end if;
  return '{"ok":true}';
end $$;

-- ---------------------------------------------------------------- 24/7 channel: stream events
-- vMix streams to a streaming service (Cloudflare Stream, Mux, ...). The service calls the
-- stream-webhook Edge Function, which verifies the call and forwards a normalised event here
-- using the service role. Members and the media team cannot call this.

/** The schedule slot the studio is most likely going live for (channel time zone). */
create or replace function public._current_slot() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tz text := coalesce(public._live() ->> 'timezone', 'UTC'); loc timestamp; dow integer; t time; r jsonb;
begin
  if not exists (select 1 from pg_timezone_names where name = tz) then tz := 'UTC'; end if;
  loc := now() at time zone tz; dow := extract(isodow from loc); t := loc::time;
  select i.data into r from public.items i
  where i.collection = 'schedule' and i.status = 'published' and (i.data ->> 'time') ~ '^\d{2}:\d{2}$'
    and case coalesce(i.data ->> 'days', 'Every day')
          when 'Every day' then true when 'Weekdays' then dow <= 5 when 'Weekends' then dow >= 6
          else array_position(array['Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays','Sundays'], i.data ->> 'days') = dow end
    -- the studio may start a little early or a while late
    and abs(extract(epoch from (t - (i.data ->> 'time')::time))) <= 3 * 3600
    and t >= (i.data ->> 'time')::time - interval '20 minutes'
  order by (coalesce(i.data ->> 'source', 'Live from the studio') = 'Live from the studio') desc,
           abs(extract(epoch from (t - (i.data ->> 'time')::time))) asc
  limit 1;
  return r;
end $$;

create or replace function public.stream_ingest(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare lv jsonb := public._live(); ev text := p ->> 'type'; slot jsonb; existing text; ttl text; started timestamptz; i public.items;
begin
  if coalesce(auth.role(), '') <> 'service_role' then perform public._fail('Not allowed', null, '42501'); end if;
  if ev = 'live.started' then
    slot := public._current_slot();
    lv := lv || jsonb_build_object('status', 'live', 'statusAt', now(), 'programme', coalesce(slot ->> 'title', lv ->> 'title'));
    if coalesce((lv ->> 'autoOnAir')::boolean, true) and (coalesce(lv ->> 'url', '') <> '' or coalesce(lv ->> 'video', '') <> '') then
      lv := lv || '{"onAir": true}';
      if slot is not null then lv := lv || jsonb_build_object('title', slot ->> 'title', 'ref', coalesce(slot ->> 'subtitle', '')); end if;
    end if;
  elsif ev = 'live.ended' then
    lv := lv || jsonb_build_object('status', 'idle', 'statusAt', now());
    if coalesce((lv ->> 'autoOnAir')::boolean, true) then lv := lv || '{"onAir": false}'; end if;
  elsif ev = 'recording.ready' then
    if coalesce(p ->> 'url', '') !~ '^https://\S+$' then perform public._fail('Recording needs an https url'); end if;
    if coalesce(p ->> 'id', '') = '' then perform public._fail('Recording needs an id'); end if;
    select id into existing from public.items where collection = 'broadcasts' and data ->> 'sourceId' = p ->> 'id';
    if existing is not null then return jsonb_build_object('ok', true, 'archived', false, 'id', existing); end if;
    if not coalesce((lv ->> 'autoArchive')::boolean, true) then return '{"ok":true,"archived":false}'; end if;
    started := coalesce(nullif(p ->> 'startedAt', '')::timestamptz, now());
    ttl := coalesce(nullif(trim(p ->> 'title'), ''), nullif(lv ->> 'programme', ''), nullif(lv ->> 'title', ''), 'Live service');
    insert into public.items (id, collection, status, data, published_at) values (
      public._new_id('br'), 'broadcasts', 'published', jsonb_build_object(
        'title', left(ttl, 140),
        'ref', 'Recorded live ' || to_char(started at time zone coalesce(nullif(lv ->> 'timezone', ''), 'UTC'), 'FMDD Mon YYYY'),
        'category', coalesce(nullif(lv ->> 'archiveCategory', ''), 'Services'),
        'video', null, 'url', p ->> 'url',
        'poster', coalesce(nullif(p ->> 'poster', ''), lv ->> 'poster'),
        'duration', case when (p ->> 'duration') ~ '^\d+(\.\d+)?$' and (p ->> 'duration')::numeric > 0 then round((p ->> 'duration')::numeric) end,
        'sourceId', p ->> 'id'),
      started) returning * into i;
    return jsonb_build_object('ok', true, 'archived', true, 'id', i.id);
  else
    perform public._fail('Unknown stream event');
  end if;
  insert into public.settings (key, value) values ('live', lv) on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('ok', true, 'live', lv);
end $$;
revoke execute on function public.stream_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.stream_ingest(jsonb) to service_role;

-- ---------------------------------------------------------------- privileges
-- Internal helpers are not callable from the API.
revoke execute on function public._require_admin(), public._fail(text, jsonb, text), public._rate_limit(text, integer, interval),
  public._new_id(text), public._member(), public._item_json(public.items, boolean), public._settings(), public._live(),
  public._required_fields(text), public._media_fields(text), public._validate_item(text, jsonb), public._with_row_ids(jsonb),
  public._current_slot()
  from public, anon, authenticated;

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, null, array[
  'image/jpeg','image/png','image/webp','image/gif','image/avif',
  'video/mp4','video/quicktime','video/webm',
  'audio/mpeg','audio/mp4','audio/x-m4a','audio/aac','audio/wav','audio/x-wav','audio/ogg','audio/flac',
  'application/pdf'])
on conflict (id) do update set public = excluded.public, allowed_mime_types = excluded.allowed_mime_types;

-- Upserting (replacing a file) needs SELECT + UPDATE as well as INSERT.
create policy media_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and public.is_admin());
create policy media_member_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = 'members' and (storage.foldername(name))[2] = auth.uid()::text);
create policy media_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.is_admin());
create policy media_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and public.is_admin());
create policy media_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.is_admin());
-- Members may upload one testimony video into media/members/<their id>/
create policy media_member_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = 'members' and (storage.foldername(name))[2] = auth.uid()::text
              and exists (select 1 from public.profiles p where p.user_id = auth.uid() and not p.banned));

-- ---------------------------------------------------------------- realtime
alter publication supabase_realtime add table public.chat, public.settings;
