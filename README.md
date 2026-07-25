# MedGrid — Hospital Operations Portal

A single-page hospital operations app (patients, doctors, appointments,
daily vitals tracking, billing/invoicing, reports, roles & users, audit
log) backed by **Supabase** (Postgres + Auth) and deployed as a static
site on **Vercel**. No build step, no framework — just `index.html` +
a Supabase project.

This version uses **real Supabase Auth accounts** (email + password)
and **Row Level Security** — not just an app-level login screen — so
that a stray copy of your public anon key can't be used to read or
write your data directly. See "Security & architecture notes" below
for exactly what is and isn't enforced by the database.

---

## 1. Create a Supabase project

1. Go to https://supabase.com → **New project**. Wait for it to finish
   provisioning.
2. Open **SQL Editor** → **New query**, paste in the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
   This creates the `profiles`, `hospitals` and `hospital_data` tables,
   locks them down with Row Level Security, and sets up a trigger so
   every new sign-up automatically gets a staff profile.
3. (Recommended, optional) Go to **Authentication → Sign In / Providers
   → Email** and turn **off** "Confirm email" so new staff can sign up
   and start using the app immediately instead of waiting on a
   confirmation email. If you leave it on, new users will see a
   "check your email" message after signing up and need to click the
   confirmation link before their first sign-in.
4. Go to **Project Settings → API** and copy:
   - **Project URL**
   - **anon public** key

## 2. Configure the app

Open `config.js` and paste in the two values from step 1.4:

```js
window.SUPABASE_URL = "https://xxxxxxxx.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

That's the only file you need to edit before deploying.

## 3. Deploy to Vercel

**Option A — Vercel dashboard (easiest)**
1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project → Import** your repo.
3. Framework preset: **Other**. Build command: *(leave empty)*.
   Output directory: `.` (already set in `vercel.json`).
4. Deploy.

**Option B — Vercel CLI**
```bash
npm i -g vercel
cd medgrid-project
vercel        # first deploy, follow the prompts
vercel --prod # promote to production
```

## 4. Create your admin account

Open the deployed site and click **Create an account**. Fill in your
name, email and a password.

**The very first person to ever sign up automatically becomes admin**
with full access. Everyone who signs up after that starts as
**Pending** and won't be able to do anything until an admin opens
**Users** and assigns them a role (Doctor, Receptionist, or Accounts).

So: sign up as yourself first, then tell your staff to sign up
themselves (from the same login screen) and come back to **Users** to
approve each of them.

---

## Security & architecture notes

Compared to the very first version of this migration (an anonymous
Supabase session and one open table), this version is meaningfully
more secure on two fronts:

- **Real accounts, database-enforced login wall.** Each staff member
  has their own Supabase Auth login. Row Level Security requires a
  valid, signed-in session belonging to an **approved** profile
  (`role <> 'pending'`) before *anything* in `hospitals` or
  `hospital_data` can be read or written. Someone with just your
  public anon key — no account, or an account nobody has approved yet
  — gets nothing back from the database.
- **Per-role, per-category permissions, enforced in Postgres.**
  `hospital_data` stores each hospital's records as one JSON document
  per category (patients, doctors, appointments, tracking, invoices,
  audit log). `supabase/schema.sql` defines `category_read_ok()` /
  `category_write_ok()` functions that check the signed-in user's role
  against an explicit allow-list **per category**, e.g.:
  - `invoices`: only `account` (and `admin`) can write; `doctor` and
    `receptionist` can read (for the billing history on a patient's
    profile) but not edit.
  - `tracking`: only `admin` can write; `doctor`/`receptionist` can
    read (for vitals history), same as the app's UI already showed.
  - `doctors`: only `receptionist` (and `admin`) can write; `doctor`
    and `account` get read-only access (needed to populate dropdowns
    when booking appointments or attributing an invoice to a doctor).

  This means a receptionist who opens dev tools and calls the Supabase
  client directly **cannot** read or write invoices or tracking data —
  Postgres itself rejects it, not just the UI.
- **Admin-only hospital management** and **self-service sign-up + admin
  approval** (no admin ever has to type a password for someone else).

What this design still does **not** give you, by nature of storing
each category as one JSON array per hospital rather than one row per
record:

- **Row-level policies within a category** — e.g. "Dr. Rao can only see
  her own patients" isn't possible at this granularity; any doctor who
  can read `patients` can read *all* patients at that hospital, same
  as today's UI.
- **A hard "delete patient" permission split.** Deleting a patient also
  needs to clean up their appointments, tracking and invoices in one
  go, which spans categories a receptionist/doctor can't all write to.
  Rather than silently fail or leave orphaned records, **the app now
  restricts permanently deleting a patient to admins only** — doctors
  and receptionists can still add and edit patients freely.
- **Per-hospital staff scoping** — every approved account can access
  every hospital in this deployment.

If you outgrow this (e.g. you need "doctor can only see their own
patients," or multiple unrelated clinics on one deployment who
shouldn't see each other at all), the next step is a fully relational
schema — real `patients`/`appointments`/etc. tables with foreign keys
and row-level policies — rather than the JSON-per-category approach
used here. Also worth doing before handling real, identifiable patient
data in a clinical setting:

1. Add per-hospital access control to `profiles` (e.g. a
   `hospital_ids uuid[]` column) if staff should be scoped to specific
   hospitals rather than seeing every hospital in the deployment.
2. Put the app behind HTTPS with proper access logging (Supabase gives
   you Postgres logs; consider also logging at the edge/CDN).
3. Review applicable regulations for handling health data in your
   country (e.g. HIPAA in the US, DPDP Act in India) — this template
   does not claim compliance with any of them.

**The anon key is meant to be public** — it's fine that it lives in
`config.js` and ships to every browser, that's how Supabase's anon key
is designed to work, and it now can't do anything without a real,
approved, signed-in session behind it, scoped to that role's allowed
categories. Never put your **service_role** key anywhere in frontend
code.

## What's stored where

| Data | Where |
|---|---|
| Staff accounts, roles, per-hospital doctor links | `profiles` table (Supabase Auth + this table) |
| Hospitals (name, address, phone) | `hospitals` table |
| Patients / doctors / appointments / tracking / invoices / audit log, per hospital | `hospital_data` table — one row per (hospital, category) holding a JSON array |
| Theme / language preference, last-used hospital | Browser `localStorage` (per device, not synced) |
| Login session | Handled entirely by Supabase Auth (its own secure storage) |

## Local development

No build step needed — just serve the folder with any static file
server and it'll talk to your real Supabase project:

```bash
npx serve .
# or
python3 -m http.server 8080
```

## Mobile responsiveness

The UI adapts down to phone widths (~360px): the sidebar becomes a
slide-in drawer (hamburger menu), the header collapses to stack the
search bar / hospital switcher / user menu on their own rows, stat
cards reflow with CSS grid instead of a fixed 4-column layout, and
form fields in modals (invoice, patient, doctor, appointment, tracking)
switch from 2–3 columns to a single column so nothing gets cramped.
Wide data tables (e.g. Appointments) use horizontal scroll within their
card rather than squeezing 8 columns into a phone screen — a deliberate
trade-off for readability over a full per-row "card" redesign of every
table.

## How this was tested

This app runs entirely in the browser against your own Supabase
project, so it can't be executed end-to-end in the environment this
was built in. What *was* done before shipping:
- Full JavaScript syntax validation.
- A cross-check that every `id` referenced in code exists in the HTML
  (and vice versa), and every button's `onclick` handler has a matching
  function — catching typos/renames that would otherwise only surface
  as a silent click-does-nothing bug in the browser.
- A manual trace of every role (admin/doctor/receptionist/account)
  through every screen and action it can reach, cross-checked against
  the `category_read_ok()`/`category_write_ok()` rules in
  `schema.sql`, to make sure no role hits a permission wall on data it
  legitimately needs (e.g. accounts staff need read-only access to
  patient names to pick a patient on an invoice, even though they have
  no "Patients" menu of their own).

What this **doesn't** replace: actually clicking through the deployed
app yourself as each role before rolling it out to real staff. Please
do that — sign up a second test account for each role, approve it from
Users, and click through its part of the app once.

## Project structure

```
medgrid-project/
├── index.html          the whole app (UI + logic)
├── config.js            ← put your Supabase URL/anon key here
├── vercel.json           static hosting config
├── supabase/
│   └── schema.sql        run once in the Supabase SQL editor
└── README.md             this file
```
