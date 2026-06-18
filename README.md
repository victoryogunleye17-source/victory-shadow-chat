# 🛡 Shadow Chat

A private, real-time messaging platform — black/navy/electric-blue dark UI,
glassmorphism, 1:1 encrypted-in-transit chat, and a protected admin dashboard
for the founder account.

Built with **vanilla HTML/CSS/JS** on the frontend and **Vercel serverless
functions** on the backend. No Supabase — uses **Neon Postgres** instead.

---

## ⚠️ Before you start: what "full send" means here

This was built in one continuous pass without being run against real
credentials (no live database, email provider, or Pusher account was
available while writing it). The code is complete and internally consistent,
but **you are the first real test environment.** Expect to spend 30–60 minutes
wiring up accounts and fixing small mismatches (a wrong env var name, a typo,
a service-specific quirk) — that's normal for a project this size, not a sign
something is fundamentally broken. Work through the checklist below in order
and you'll get there.

---

## 1. What you need to create (all free tier)

| Service | Why | Sign up |
|---|---|---|
| **Neon** | Postgres database | https://neon.tech |
| **Resend** | Sending verification/reset emails | https://resend.com |
| **Pusher** (Channels) | Real-time message delivery | https://pusher.com |
| **Vercel** | Hosting + Blob file storage | https://vercel.com |
| **Upstash** | Redis for rate limiting | https://upstash.com |

## 2. Local setup

```bash
git clone <your-repo-url> shadow-chat
cd shadow-chat
npm install
cp .env.example .env
```

Fill in `.env` with real values from each service above (see comments in
`.env.example` for where to find each one).

## 3. Initialize the database

Open your Neon project's SQL editor (or use `psql` with your `DATABASE_URL`)
and run the entire contents of `db/schema.sql`. This creates all tables.

## 4. Set the owner email

`OWNER_EMAIL` in your env vars must exactly match
`victoryogunleye17@gmail.com` (already set in `.env.example`). When that email
registers an account, it's automatically granted the `owner` role — full
admin dashboard access, including the Legal Requests tab. This happens in
`lib/auth.js` → `resolveRoleForEmail()`, the only place role elevation occurs.

**Register that account first**, before testing as a normal user, so you can
confirm the owner flow works.

## 5. Vercel Blob (file storage)

```bash
npm i -g vercel
vercel login
vercel link
vercel blob store add
```

This generates `BLOB_READ_WRITE_TOKEN` — copy it into your env vars (both
locally and in Vercel's dashboard).

## 6. Run locally

```bash
vercel dev
```

Visit `http://localhost:3000`. Register, check your email (or check the
terminal logs — if Resend isn't configured yet, verification links print to
the console instead of failing silently), verify, log in.

## 7. Deploy

```bash
vercel --prod
```

Add every variable from `.env` into **Vercel → Project → Settings →
Environment Variables** (for Production, Preview, and Development), then
redeploy. Set `APP_URL` and `EMAIL_FROM` to your real deployed domain once you
have one — emails link back to `APP_URL`.

Set `CRON_SECRET` to a random string in env vars too — it protects the
presence-sweep cron job from being called by anyone else.

---

## Project structure

```
api/
  auth/        — register, login, logout, verify-email, password reset, profile
  chat/        — conversations, messages, reactions, typing, block, search,
                 pusher-auth, heartbeat, presence-sweep (cron)
  admin/       — stats, users, moderate-user, reports, legal-requests,
                 security-logs (all gated by lib/adminGuard.js)
  reports/     — user-initiated report submission
  upload/      — file/image upload to Vercel Blob
  config.js    — exposes only public (non-secret) frontend config
lib/           — shared backend helpers (db, auth, email, pusher, rate
                 limiting, security logging, admin guard)
public/        — all frontend pages, css/, js/
db/schema.sql  — run this once against your Postgres database
```

## How the admin/safety model works (read this before treating it as a black box)

The brief asked for admins to be able to view "sensitive messages" for
matters like national security. A standing admin backdoor into private
messages was deliberately **not** built — that's a serious privacy/legal
problem most jurisdictions don't let a platform self-authorize, and it
undermines the "secure and private" promise to your users. Instead:

- **`reports` table** — the only way a message becomes visible to admins.
  A user reports something; a snapshot of that specific message is stored at
  report time (so it survives later edits/deletes) and shows up in
  `Admin → Reports`. Admins do not get to browse arbitrary conversations.
- **`legal_requests` table** — owner-only, for logging law-enforcement /
  court-order requests with a documented legal basis. It's a case-tracker,
  not a one-click "read their messages" button — actually pulling message
  content for a fulfilled request is meant to be a separate, manual, audited
  step you do directly against the database, not something exposed as an
  API action.
- **`security_logs` table** — abnormal system events (failed logins,
  rate-limit hits, unauthorized admin-route attempts, admin actions).
- **Location** — only ever stored/shown if the user explicitly opts in via
  the profile "share location" toggle. Off by default.
- Every admin API route re-checks the caller's role **against the database**
  on every request (`lib/adminGuard.js`), not just trusting the JWT — so a
  demoted or banned admin loses access immediately, not whenever their token
  happens to expire.
- The founder account (`OWNER_EMAIL`) can never be banned, suspended, or
  demoted by anyone — including other admins — to prevent lockout.

If your actual legal/compliance needs differ from this, that's a conversation
worth having explicitly rather than bolting on broader access later.

## Known gaps / next steps

- **Message encryption**: transport is encrypted (HTTPS/TLS, standard for any
  Vercel deployment), and the architecture is messages-at-rest-in-Postgres,
  visible to admins only via the report flow above. True end-to-end
  encryption (where even the server can't read content) is a meaningfully
  bigger lift — not included here, flag if you want to pursue it.
- **Multipart uploads**: the upload endpoint accepts base64 JSON rather than
  true multipart/form-data, to avoid extra parsing dependencies. Fine up to
  the 15MB cap; revisit if you need larger files.
- No automated test suite — test manually using the flows above first.
