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

**There is no self sign-up.** The login screen only lets people sign
in — there's no "Create an account" option. Accounts are created one
of two ways:
1. **Seeded from environment variables** — one account per role
   (admin/doctor/receptionist/account), defined by env vars on Vercel.
   Whenever you change the password env var and re-run the seed
   endpoint, that new password is written into Supabase Auth — so the
   "source of truth" password always matches your env var.
2. **Created by an admin, in-app** — once at least one admin account
   exists, that admin can add/edit/delete any user and reset anyone's
   password straight from the **Users** page. No further env var edits
   needed for day-to-day staff changes.

See "4. Create your accounts" below for exact steps.

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

## 4. Create your accounts

There's no sign-up button in the app — every login is created for you,
either by an env-var-driven seed script (for the first admin, and
optionally other roles) or later by an admin from the **Users** page.

### 4a. Set the required environment variables (Vercel)

In Vercel → your project → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | same Project URL as in `config.js` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → **service_role** key. **Secret — only ever set this as a Vercel env var, never in `config.js` or any frontend file.** |
| `SEED_SECRET` | any long random string you make up — protects the seed endpoint |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | your admin login |

Optionally also set `SEED_DOCTOR_EMAIL`/`_PASSWORD`/`_NAME`,
`SEED_RECEPTIONIST_EMAIL`/`_PASSWORD`/`_NAME`, and
`SEED_ACCOUNT_EMAIL`/`_PASSWORD`/`_NAME` if you want those roles
pre-created too — otherwise just create them later from the Users page.

Redeploy so the functions pick up the new env vars.

### 4b. Run the seed endpoint once

```bash
curl -X POST https://your-site.vercel.app/api/seed-users \
     -H "x-seed-secret: <your SEED_SECRET value>"
```

This creates (or, if it already exists, resets the password of) each
account you configured, with the matching role already assigned — no
"pending" step for these. **To change one of these passwords later:**
update the `SEED_*_PASSWORD` env var in Vercel, redeploy, and run the
same `curl` command again — the new password is written straight into
Supabase Auth.

### 4c. Everything after that: the Users page

Sign in as the admin account you just seeded, open **Users**, and:
- **+ Add user** — create a doctor/receptionist/accounts login directly
  (no env vars needed for this).
- **✏️ edit icon** — rename a user, change their role, or (for doctors)
  link them to a specific doctor record for the current hospital.
- **🔑 key icon** — reset a user's password.
- **🗑️ trash icon** — permanently delete a user's login.

All of these are admin-only and go through `/api/admin-users.js`,
which double-checks server-side (using the service_role key) that the
caller really is a signed-in admin before doing anything — so this is
safe to expose even though it's called from the browser.

---

## 5. Patient live-lookup portal (no patient account needed)

On the login screen, there's now a **"Are you a patient? Check your
details live →"** link. A patient enters:

- their **Patient code** — a 6-character code (just the last 6
  characters of their internal record id, shown to staff on that
  patient's **Patient Profile** page, next to a 📋 copy button), and
- their **registered phone number**

...and gets back, live, only their own: upcoming/past appointments,
recent vitals, and billing status (paid/partial/unpaid + balance due).
There's a **↻ Refresh** button (re-queries the database on demand) and
a **🖨️ Print** button.

This goes through a new public endpoint, `/api/patient-lookup.js`,
which is deliberately the *only* endpoint in the app that doesn't
require a signed-in session — but it:
- only ever returns the **one** patient whose code *and* phone both
  match (both must match; a wrong guess gets the same generic "not
  found" message either way, so this can't be used to fish for valid
  codes/phones one field at a time),
- never exposes other patients, staff accounts, or hospital-wide data,
- has a basic per-IP throttle (15 attempts / 5 minutes) to slow down
  brute-forcing. This is an in-memory soft limit that resets when the
  serverless function cold-starts — fine for a small clinic, but if
  you expect heavier traffic/abuse, put a proper rate limiter (e.g.
  Vercel WAF or Upstash) in front of it instead.

No extra env vars needed — it reuses `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` you already set up in step 4a.

---

## 6. Patient documents (lab reports, prescriptions, scans)

Each Patient Profile page now has a **Documents** card — admins, doctors
and receptionists can upload a PDF or image (up to 10 MB) straight from
there, and anyone with read access to patients can view/download it.
Files are stored in a private Supabase Storage bucket, not in the
database, so they don't bloat your `hospital_data` rows.

**Setup**: re-run `supabase/schema.sql` in the Supabase SQL Editor (it's
safe to re-run — everything in it is idempotent). It creates a
`patient-documents` Storage bucket and locks it down with the same
role rules as the rest of the app:
- **read**: anyone who could already see patient records (admin,
  doctor, receptionist, account)
- **upload**: admin, doctor, receptionist
- **delete**: admin only

No extra env vars needed for this either.

---

## 7. WhatsApp / SMS appointment reminders (optional)

The 💬 "copy reminder" button next to each booked appointment now has a
📱 button beside it that sends the same message straight over WhatsApp,
via [Twilio](https://www.twilio.com). This is optional — if you don't
set it up, the 💬 copy button keeps working exactly as before, and the
📱 button will just show a clear "not set up yet" error instead of
crashing anything.

**Setup**:
1. Create a free Twilio account and grab your **Account SID** and
   **Auth Token** from the Twilio Console.
2. For quick testing, use Twilio's **WhatsApp Sandbox** number
   (`whatsapp:+14155238886`) — each staff member's own phone needs to
   join the sandbox once by sending the given code on WhatsApp. For
   real patient-facing use, apply for a proper WhatsApp Business sender
   through Twilio instead (takes a few days for approval).
3. In Vercel → Environment Variables, add:

   | Variable | Value |
   |---|---|
   | `TWILIO_ACCOUNT_SID` | from Twilio Console |
   | `TWILIO_AUTH_TOKEN` | from Twilio Console |
   | `TWILIO_WHATSAPP_FROM` | e.g. `whatsapp:+14155238886` |
   | `TWILIO_SMS_FROM` *(optional)* | a Twilio number with SMS enabled, if you want plain SMS too |

4. Redeploy. That's it — no code changes needed.

Any signed-in staff member (not just admins) can send a reminder,
since receptionists and doctors are usually the ones actually doing
it. The endpoint (`/api/send-reminder.js`) still checks that the
caller has a valid, non-pending session before sending anything.

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
- **Admin-only hospital management**, and **no self sign-up at all** —
  every login is either seeded from server-side env vars or created by
  an admin in-app, both via serverless functions that hold the
  Supabase `service_role` key (never shipped to the browser).

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

The main app (`index.html`) needs no build step — serve the folder
with any static file server and it'll talk to your real Supabase
project:

```bash
npx serve .
# or
python3 -m http.server 8080
```

The two files under `api/` (`seed-users.js`, `admin-users.js`) are
Vercel serverless functions and **won't run** under a plain static
server — a plain static server only serves files, it doesn't execute
Node code. To test them locally, use the Vercel CLI instead, which
runs both the static site and the `api/` functions together:

```bash
npm install
npm i -g vercel
vercel dev
```

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SEED_SECRET`, and any
`SEED_*` variables in a local `.env` file (or via `vercel env pull`)
before running `vercel dev`, the same way you'd set them in the Vercel
dashboard for production.

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
├── config.js            ← put your Supabase URL/anon key here (safe, public)
├── package.json          declares @supabase/supabase-js for the api/ functions
├── vercel.json           static hosting config
├── api/
│   ├── _supabaseAdmin.js  shared helper (service_role client) — not an endpoint itself
│   ├── seed-users.js      POST once (and after changing a SEED_*_PASSWORD) to create/sync role accounts from env vars
│   ├── admin-users.js     used by the in-app Users page: create / reset password / delete a login
│   ├── patient-lookup.js  public endpoint behind the "Check your details" patient portal
│   └── send-reminder.js   sends WhatsApp/SMS appointment reminders via Twilio (optional)
├── supabase/
│   └── schema.sql        run once in the Supabase SQL editor
└── README.md             this file
```
