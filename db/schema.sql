-- TeachToReach — Supabase schema
-- Safe to run this whole file in the Supabase SQL Editor any time —
-- table creation is skipped if it already exists, and the function/
-- policies are replaced cleanly rather than erroring on a second run.

create table if not exists tutor_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  student_level text,
  school_type text,
  concerns text,
  subjects text[],
  frequency text,
  budget text,
  location text,
  mode text,
  parent_name text,
  parent_phone text,
  parent_email text
);

create table if not exists tutor_profiles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tutor_name text,
  tutor_phone text,
  tutor_tier text,
  tutor_exp text,
  levels text[],
  subjects text[],
  rate_min text,
  rate_max text,
  tutor_location text,
  tutor_avail text,
  telegram_handle text,
  tutor_notes text
);

-- Row Level Security: the public site can only INSERT, never read
-- other people's submissions back. Grace reviews data from the
-- Supabase Table Editor (logged in with her own account), not the site.
alter table tutor_requests enable row level security;
alter table tutor_profiles enable row level security;

drop policy if exists "Public can submit tutor requests" on tutor_requests;
create policy "Public can submit tutor requests"
  on tutor_requests for insert
  to anon
  with check (true);

drop policy if exists "Public can submit tutor profiles" on tutor_profiles;
create policy "Public can submit tutor profiles"
  on tutor_profiles for insert
  to anon
  with check (true);

-- ==========================================================================
-- Instant tutor-match function
--
-- Called by the public site (anon role) right after a parent submits a
-- request, to show an immediate "X tutors already match" teaser. It is
-- SECURITY DEFINER so it can read tutor_profiles even though anon has no
-- direct SELECT policy on that table above — but it only ever returns
-- anonymized columns. tutor_name, tutor_phone, and telegram_handle are
-- never selected here, so they can't leak through this path no matter
-- what the caller asks for. Grace remains the only one who can see full
-- tutor contact details, from the Supabase dashboard.
-- ==========================================================================

create or replace function match_tutors(
  p_subjects text[],
  p_level_bucket text,
  p_location text,
  p_budget_min numeric,
  p_budget_max numeric
)
returns table (
  tutor_tier text,
  subjects text[],
  rate_min text,
  rate_max text,
  tutor_location text,
  tutor_avail text,
  score int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select
    tp.tutor_tier,
    tp.subjects,
    tp.rate_min,
    tp.rate_max,
    tp.tutor_location,
    tp.tutor_avail,
    (
      -- subject overlap: up to 40, scaled by how many requested subjects this tutor covers
      (40 * cardinality(array(select unnest(tp.subjects) intersect select unnest(p_subjects)))
          / greatest(cardinality(p_subjects), 1))
      -- level bucket match: 25
      + case when p_level_bucket = any(tp.levels) then 25 else 0 end
      -- location: loose substring match either direction, or tutor marked "anywhere": 20
      + case
          when tp.tutor_location ilike '%anywhere%' then 20
          when p_location is not null and tp.tutor_location ilike '%' || p_location || '%' then 20
          when p_location is not null and p_location ilike '%' || tp.tutor_location || '%' then 20
          else 0
        end
      -- rate range overlap: 15 (guarded — malformed rate text just scores 0, never errors)
      + case
          when tp.rate_min ~ '^[0-9]+(\.[0-9]+)?$'
           and tp.rate_max ~ '^[0-9]+(\.[0-9]+)?$'
           and tp.rate_min::numeric <= p_budget_max
           and tp.rate_max::numeric >= p_budget_min
          then 15
          else 0
        end
    )::int as score
  from tutor_profiles tp
  where tp.subjects && p_subjects  -- hard filter: must share at least one subject
  order by score desc
  limit 3;
end;
$$;

grant execute on function match_tutors(text[], text, text, numeric, numeric) to anon;

-- ==========================================================================
-- Reviews
--
-- Same insert-only pattern as the two tables above, but with one addition:
-- a public SELECT policy scoped to `approved = true`. Nothing shows on the
-- site until someone flips that flag in the Supabase Table Editor — this is
-- deliberate curation, not an auto-publish-on-4-stars filter, to match the
-- site's whole "a real human reviews everything" positioning.
-- ==========================================================================

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  author_name text,
  role text,        -- 'Parent' or 'Tutor'
  context text,      -- e.g. "Parent, Sec 2" or "Tutor, Physics & Math"
  rating int,
  review_text text,
  approved boolean not null default false
);

alter table reviews enable row level security;

drop policy if exists "Public can submit reviews" on reviews;
create policy "Public can submit reviews"
  on reviews for insert
  to anon
  with check (approved = false);  -- can't self-approve via a crafted API call

drop policy if exists "Public can read approved reviews" on reviews;
create policy "Public can read approved reviews"
  on reviews for select
  to anon
  using (approved = true);

-- Seed mockup reviews (approved) so the section isn't empty while real ones
-- trickle in. Only runs if the table is currently empty, so re-running this
-- whole file won't duplicate rows. Safe to delete these once you have
-- enough real ones — see db/README or just delete by author_name in the
-- Table Editor.
insert into reviews (author_name, role, context, rating, review_text, approved)
select * from (values
  ('Mrs. Tan', 'Parent', 'Parent, Sec 2', 5, 'Grace actually asked about my son''s attention span before suggesting anyone. Small thing, but no other agency bothered.', true),
  ('Mr. Rahman', 'Parent', 'Parent, Primary 5', 5, 'Swapped tutors once because the first one wasn''t a great fit — no drama, sorted within a week.', true),
  ('Wei Jie', 'Tutor', 'Tutor, Physics & Math', 4, 'As a tutor, I used to get flooded with assignments miles from home. Now I only hear about the ones worth my time.', true),
  ('Mrs. Lim', 'Parent', 'Parent, JC2', 5, 'Found someone who actually knew the H2 syllabus cold, not just "can teach everything." Made a real difference for the A-Levels.', true),
  ('Mdm. Farah', 'Parent', 'Parent, Primary 3', 5, 'My daughter needed a patient tutor, not a strict one. Grace got that right on the first try.', true),
  ('Priya', 'Tutor', 'Tutor, English & Malay', 5, 'No cold DMs, no lowball rate negotiations — I set my range and get matched to families who are actually fine with it.', true)
) as seed(author_name, role, context, rating, review_text, approved)
where not exists (select 1 from reviews);

-- Optional screenshot attached to a review (e.g. a chat screenshot Grace
-- wants to show alongside or instead of typed review text).
alter table reviews add column if not exists screenshot_url text;

-- Public bucket Grace can drag-and-drop into directly from her own
-- Supabase dashboard (Storage section) — no separate upload page needed.
-- Files uploaded there get a public URL she can paste into a review row's
-- screenshot_url column in the Table Editor, same place she already
-- approves reviews.
insert into storage.buckets (id, name, public)
values ('review-screenshots', 'review-screenshots', true)
on conflict (id) do nothing;

-- ==========================================================================
-- Telegram bot: assignment matching
--
-- Grace/the user create assignments by inserting a row into `assignments`
-- via the Supabase Table Editor (same manual-curation pattern as approving
-- reviews). A Database Webhook on INSERT calls
-- netlify/functions/post-assignment.js, which posts it to the Telegram
-- channel with an "Apply" button and writes telegram_message_id back.
--
-- `assignments`, `applications`, and `bot_sessions` all have RLS enabled
-- with ZERO policies — unlike every other table above, there is no anon
-- insert-only policy here. Only the Supabase service-role key (used
-- server-side by the bot's Netlify Functions, never exposed to the
-- browser) can read or write these three tables. The public site and the
-- public anon key have no access to them at all.
-- ==========================================================================

-- Extend tutor_profiles so the bot's richer registration (age, gender,
-- qualifications, etc.) writes into the same pool the website's
-- "Become a tutor" form already uses, rather than a separate table.
alter table tutor_profiles add column if not exists telegram_user_id bigint;
alter table tutor_profiles add column if not exists age text;
alter table tutor_profiles add column if not exists gender text;
alter table tutor_profiles add column if not exists qualifications text;
alter table tutor_profiles add column if not exists current_education text;
alter table tutor_profiles add column if not exists tutoring_experience text;
alter table tutor_profiles add column if not exists teaching_style text;
alter table tutor_profiles add column if not exists track_record text;
alter table tutor_profiles add column if not exists can_present_certificates text;
alter table tutor_profiles add column if not exists profile_complete boolean not null default false;

-- Lets the bot upsert by telegram_user_id (on conflict ... do update) so
-- resuming a saved-but-incomplete registration updates the same row
-- instead of creating a duplicate. Multiple NULLs (website-only profiles
-- with no bot registration) are still allowed — Postgres unique indexes
-- never treat NULL as equal to another NULL.
create unique index if not exists tutor_profiles_telegram_user_id_key
  on tutor_profiles (telegram_user_id);

create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  student_level text,
  subjects text[],
  location text,
  rate_min text,
  rate_max text,
  frequency text,
  notes text,
  status text not null default 'open',        -- 'open' / 'filled' / 'cancelled'
  telegram_message_id bigint,
  channel_post_error text
);

alter table assignments enable row level security;

create table if not exists applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  assignment_id uuid references assignments(id) on delete cascade,
  tutor_telegram_id bigint,
  tutor_profile_id uuid references tutor_profiles(id) on delete set null,
  status text not null default 'applied'      -- 'applied' / 'shortlisted' / 'not_selected'
);

alter table applications enable row level security;

-- The bot's own conversation-state memory (current step in the
-- registration wizard, draft answers, which assignment is being viewed).
-- Telegram webhooks are stateless per-request, so this table is what makes
-- multi-step flows and "resume where you left off" possible.
create table if not exists bot_sessions (
  telegram_user_id bigint primary key,
  state text not null default 'idle',
  context jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table bot_sessions enable row level security;
