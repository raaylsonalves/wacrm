# Deploying to Vercel

The app is plain Next.js with no server actions and no background
workers of its own, so Vercel needs no special configuration beyond
env vars — but three things are easy to miss on a first deploy, all
covered below: build-time vs runtime variables, the automations/flows
cron (Vercel's own Cron Jobs are too coarse on the Hobby plan), and
Supabase Auth's redirect allowlist (silently breaks invite
acceptance if skipped).

## 1. Environment variables

Same variables as `.env.local.example`. Vercel doesn't distinguish
build-arg vs runtime the way Docker does — every `NEXT_PUBLIC_*` var
is still inlined into the client bundle at build time (so changing
one requires a redeploy), everything else is read at request time.

Minimum to get the app running:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ENCRYPTION_KEY` (64 hex chars — generate with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  and never rotate it after real WhatsApp/AI keys are saved; there is
  no re-encryption path)
- `META_APP_SECRET`
- `NEXT_PUBLIC_SITE_URL` — your production URL
- `NEXT_PUBLIC_APP_LOCALE` — `en | ko | pt | es`

Set each var for the **Production** environment specifically (not
just Preview/Development) — a var scoped to the wrong environment is
silently ignored on the live deploy. After adding or changing a
`NEXT_PUBLIC_*` var, redeploy without build cache (Deployments → ⋯ →
Redeploy, uncheck "Use existing Build Cache") — a plain redeploy can
reuse a build that still has the old value baked in.

## 2. Automations / flows cron

Nothing inside a Vercel deployment is scheduled by itself. Wait steps
in Automations and suspended Flow runs both need something to hit,
on a schedule:

- `GET /api/automations/cron`
- `GET /api/flows/cron`
- `GET /api/appointments/cron` (agenda reminders — accepts either
  `x-cron-secret` or `Authorization: Bearer`)

All require the shared secret `AUTOMATION_CRON_SECRET` (generate
with `openssl rand -hex 32` and set it as an env var) and return 503
until that variable is set.

**Vercel's native Cron Jobs (`vercel.json` `crons`) don't work well
here on the Hobby plan** — it caps cron frequency at once a day, far
too coarse for draining time-based waits. Use a free external pinger
instead, e.g. [cron-job.org](https://cron-job.org):

1. Create one job per route above.
2. Method `GET`, interval every 5 minutes (or whatever granularity
   your automations need).
3. Add a custom header: `x-cron-secret: <AUTOMATION_CRON_SECRET>`.

If you're on Vercel Pro (or another host without the once-a-day cap)
and prefer native cron, note that Vercel Cron sends
`Authorization: Bearer <CRON_SECRET>` instead of a custom header —
`/api/automations/cron` already accepts either form (it checks
`x-cron-secret` first, then falls back to a bearer token matching
`AUTOMATION_CRON_SECRET`); `/api/flows/cron` currently only accepts
`x-cron-secret`, so stick to the external-pinger approach for that
route, or add the same bearer fallback before relying on native cron
for it.

## 3. Supabase Auth redirect allowlist

Supabase only honors `emailRedirectTo` (used by signup and the invite
flow to send someone back to `/join/<token>` after confirming their
email) if the target URL is on the project's allowlist. Skipping this
doesn't error — it silently falls back to the Site URL, which drops
an invited teammate on `/dashboard` as the **owner of a brand-new
personal account** instead of on the invite-acceptance screen. That
personal account is otherwise indistinguishable from a real one, so
this is easy to miss until someone reports being unable to see the
team's data.

In the Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL**: your production URL (e.g.
  `https://your-app.vercel.app`)
- **Redirect URLs**: add `https://your-app.vercel.app/**`

Do this before sending your first invite. If you already sent one and
the invitee ended up owning a fresh personal account instead of
joining yours, fix the redirect config above, then either have them
redeem a new invite link while signed in, or move their `profiles`
row to the right account and delete the orphan personal account
directly in the database.

## 4. WhatsApp number registration

Unrelated to Vercel specifically, but the most common reason a
freshly-deployed webhook receives nothing: a WhatsApp number must be
**registered** with the Cloud API (Meta for Developers → WhatsApp →
API Setup → the number shows "Not registered" until you do this)
before it can send or receive anything through `/api/whatsapp/webhook`.
Registering it also permanently detaches that number from the regular
WhatsApp / WhatsApp Business consumer app — the two are mutually
exclusive on the same number.

If the in-dashboard "Register" action fails with a generic
`field_exception` server error, call the Graph API directly instead
(bypasses whatever's flaky in that particular UI flow):

```bash
curl -X POST "https://graph.facebook.com/v26.0/<phone-number-id>/register" \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"messaging_product": "whatsapp", "pin": "123456"}'
```

Use a 6-digit PIN that isn't an obvious sequence. A `{"success": true}`
response means the number is live; refresh the Meta dashboard to see
the status flip.
