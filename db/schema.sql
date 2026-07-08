-- TeachToReach — Supabase schema
-- Run once in the Supabase SQL Editor for this project.

create table tutor_requests (
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

create table tutor_profiles (
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

create policy "Public can submit tutor requests"
  on tutor_requests for insert
  to anon
  with check (true);

create policy "Public can submit tutor profiles"
  on tutor_profiles for insert
  to anon
  with check (true);
