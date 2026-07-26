-- ─────────────────────────────────────────────────────────────
-- MedGrid — Supabase schema (v2: real Supabase Auth + RLS)
-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste this → Run)
-- ─────────────────────────────────────────────────────────────
--
-- This version uses real Supabase Auth accounts (email + password)
-- instead of anonymous sessions, and enforces "you must be a signed-in,
-- admin-approved staff member" at the database level via Row Level
-- Security — not just in the app's UI. See README.md → "Security &
-- architecture notes" for exactly what this does and doesn't cover.

-- ───────────────────────────── profiles ─────────────────────────────
-- One row per staff member, linked 1:1 to a Supabase Auth user.
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text not null default '',
  role         text not null default 'pending'
                 check (role in ('admin','doctor','receptionist','account','pending')),
  doctor_links jsonb not null default '{}'::jsonb, -- { "<hospital_id>": "<doctor_id>" }
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Helper functions (SECURITY DEFINER so they bypass RLS internally —
-- this is what lets policies safely reference `profiles` from within a
-- policy that is itself on `profiles`, without infinite recursion).
create or replace function public.current_role()
returns text
language sql security definer set search_path = public stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql security definer set search_path = public stable
as $$
  select coalesce(public.current_role() = 'admin', false);
$$;

create or replace function public.is_active_user()
returns boolean
language sql security definer set search_path = public stable
as $$
  select coalesce(public.current_role() is not null and public.current_role() <> 'pending', false);
$$;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "admins read all profiles" on public.profiles;
create policy "admins read all profiles" on public.profiles
  for select using (public.is_admin());

drop policy if exists "admins update profiles" on public.profiles;
create policy "admins update profiles" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins delete profiles" on public.profiles;
create policy "admins delete profiles" on public.profiles
  for delete using (public.is_admin());

-- Bootstrap: automatically create a profile row whenever a new auth user
-- appears. Every account in this app is now created deliberately — either
-- by /api/seed-users.js (reading role/password from env vars) or by an
-- admin via the Users page (/api/admin-users.js) — both of which set the
-- correct role themselves right after creating the account. This trigger
-- just guarantees a profile row always exists as a safety net; it never
-- grants admin automatically (unlike the old self-signup version).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────────── hospitals ─────────────────────────────
create table if not exists public.hospitals (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  address    text not null default '',
  phone      text not null default '',
  created_at timestamptz not null default now()
);

alter table public.hospitals enable row level security;

drop policy if exists "active users read hospitals" on public.hospitals;
create policy "active users read hospitals" on public.hospitals
  for select using (public.is_active_user());

drop policy if exists "admins insert hospitals" on public.hospitals;
create policy "admins insert hospitals" on public.hospitals
  for insert with check (public.is_admin());

drop policy if exists "admins update hospitals" on public.hospitals;
create policy "admins update hospitals" on public.hospitals
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins delete hospitals" on public.hospitals;
create policy "admins delete hospitals" on public.hospitals
  for delete using (public.is_admin());

-- ─────────────────────────── hospital_data ───────────────────────────
-- Each hospital's records, split into one JSON document per category.
-- (Not fully normalized into one-row-per-patient — see README for the
-- trade-offs of this design and how to go further if you need to.)
create table if not exists public.hospital_data (
  hospital_id uuid not null references public.hospitals(id) on delete cascade,
  category    text not null check (category in ('patients','doctors','appointments','tracking','invoices','auditlog')),
  value       jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (hospital_id, category)
);

alter table public.hospital_data enable row level security;

-- Fine-grained, per-category, per-role permissions — mirrors exactly what
-- each role can already do in the app's UI, now enforced by Postgres too.
-- (Note: because each category is stored as a single JSON array per
-- hospital rather than one row per record, "write" here covers add/edit
-- *and* delete of items within that category — Postgres can't tell those
-- apart at this granularity. The one place that matters — deleting a
-- whole patient, which also needs to clean up their tracking & invoice
-- records — is restricted to admins in the app itself for this reason.)
create or replace function public.category_read_ok(cat text)
returns boolean
language sql security definer set search_path = public stable
as $$
  select case
    when public.is_admin() then true
    when cat = 'patients'     then public.current_role() in ('doctor','receptionist','account') -- account needs this to pick a patient when billing
    when cat = 'doctors'      then public.current_role() in ('doctor','receptionist','account') -- doctor needs this to book appointments; account for invoice attribution
    when cat = 'appointments' then public.current_role() in ('doctor','receptionist')
    when cat = 'tracking'     then public.current_role() in ('doctor','receptionist')
    when cat = 'invoices'     then public.current_role() in ('doctor','receptionist','account')
    when cat = 'auditlog'     then false -- admin already covered above
    else false
  end;
$$;

create or replace function public.category_write_ok(cat text)
returns boolean
language sql security definer set search_path = public stable
as $$
  select case
    when public.is_admin() then true
    when cat = 'patients'     then public.current_role() in ('doctor','receptionist')
    when cat = 'doctors'      then public.current_role() = 'receptionist'
    when cat = 'appointments' then public.current_role() in ('doctor','receptionist')
    when cat = 'tracking'     then false -- admin only
    when cat = 'invoices'     then public.current_role() = 'account'
    when cat = 'auditlog'     then public.is_active_user() -- every role logs its own actions
    else false
  end;
$$;

drop policy if exists "active users read hospital_data" on public.hospital_data;
drop policy if exists "active users insert hospital_data" on public.hospital_data;
drop policy if exists "active users update hospital_data" on public.hospital_data;
drop policy if exists "active users delete hospital_data" on public.hospital_data;

create policy "category read" on public.hospital_data
  for select using (public.category_read_ok(category));

create policy "category insert" on public.hospital_data
  for insert with check (public.category_write_ok(category));

create policy "category update" on public.hospital_data
  for update using (public.category_write_ok(category)) with check (public.category_write_ok(category));

create policy "category delete" on public.hospital_data
  for delete using (public.is_admin());
