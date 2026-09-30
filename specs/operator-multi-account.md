# Spec: Operator mode — one person operating many client accounts

**Status update (2026-09-30), after v1:** (1) **Modules per account** (migration 091): `accounts.modules text[]`, NULL = everything. A client's own users see only the modules the agency sold (inbox, cases, contacts, pipelines, prospecting, agenda, ai, broadcasts, channels, settings; dashboard and notifications always on); operators always see all. Presets Completo/Atendimento/Automação and per-module toggles in the portfolio (`set_account_modules`, `operator_account_modules`). `ModuleGuard` never mounts a page the client did not buy. This is navigation packaging, **not authorization**: RLS still only checks membership, so a client user could read a disabled module's tables through the API. Enforcing it means a module check in RLS on each module's tables plus API-route guards; deferred until a real client is sold a partial plan. (2) **Agency team** (migration 092): the home account's owner makes teammates operators (`set_agency_operator`) and assigns clients (`set_operator_assignment`); each teammate only sees assigned clients; only the owner creates client accounts; unassigning sends a teammate inside that client back home. **Known limit, accepted:** an operator inside a client is out of the agency account meanwhile (one active account per user), so they don't receive the agency's notifications or conversations. Still open: client-user invites from the portfolio, monthly usage per client, agent templates cloned across clients, connect links, multiple official Meta numbers per account.

**Status: v1 implemented (2026-09-30).** Migration 090: `platform_operators` (seeded with one operator), `operator_accounts`, `switch_account`, `create_client_account` (client accounts marked `managed_by`, so the one-account-per-owner index skips them), `operator_portfolio` (counts/health only). UI: `/operator` portfolio, "Operando: …" banner with back-home, stale-tab reload dialog. Not in v1: client-initiated grant/revoke, `essential` UI profile, connect links, `x-wacrm-account` header check, and handing ownership to a client who already owns a signup account (the owner index still blocks that transfer).

> Ported in spirit from deskcomm's "Console de Agência"
> (`docs/specs/19-spec-console-de-agencia.md`), adapted to what wacrm
> already is: a multi-tenant app where a *user* belongs to exactly one
> *account*. The use case that motivates it: a small business (say a
> barbershop) doesn't want a CRM — it wants its WhatsApp answered and its
> bookings in Google Calendar, and prefers that **someone else runs it**.
> That someone is the operator (the user of this repo), serving N clients
> from one install. Depends on `specs/google-calendar-sync.md` for the
> "bookings land in the owner's calendar" half.

## Problem

Today an operator can only serve a second client by creating a **second
login** for them (different e-mail, different password, log out and in).
That's deliberate in the code, not an oversight:
`redeem_invitation` (migration 019, lines 178-189) refuses to add a user
who already belongs to another shared account —

> "You are already in a shared account; sign up with a different email to
> join this one"

— and `profiles` carries exactly one `(account_id, account_role)` per
user, which `is_account_member()` (migration 017) and therefore every RLS
policy in the schema key off. There is also nothing that lets the operator
see, at a glance, whether each client's WhatsApp number is still
connected, whether the AI is answering, or whether a calendar token
expired — the things they are being paid to keep alive.

Second, a client who only wants "WhatsApp + agenda" is handed the whole
CRM (pipelines, automations, flows, broadcasts, AI settings). For a
barbershop owner that is noise and a way to break things.

Third, connecting a client's number or Google account needs the *client's*
phone/consent (QR scan, OAuth), but the operator is remote. Today the only
way is screen-sharing or asking for the password.

## Non-goals

- **Billing/retainer per client.** The prior art (deskcomm §1.2) chose a
  retainer per operated client and explicitly no metering. Billing is
  `specs/billing-subscriptions.md`'s problem (incl. per-extra-number).
- **White-label per client** (own domain, own login page). Per-account
  name/logo/colour already exist (`specs/account-branding.md`, and the
  installed-app branding shipped with the PWA work).
- **Account hierarchy / sub-accounts / SSO.** Flat: a user has N
  memberships, one of them active.
- **Running parallel clients in one browser profile.** See the tab
  hazard below — one active client at a time per session is the model.
- **Cross-account reporting with customer data.** The portfolio shows
  counts and health, never messages or contact PII.

## Current behavior

- `profiles(user_id, account_id, account_role)` — one row per user;
  `getCurrentAccount()` (`src/lib/auth/account.ts:106`) resolves the
  account from it; `is_account_member(target, min_role)` reads it.
- Roles `owner > admin > agent > viewer` (`src/lib/auth/roles.ts`);
  `canDeleteAccount` / `canTransferOwnership` are owner-only;
  `canManageMembers` is admin+.
- Ownership transfer already exists (migration 020 / members API).
- `audit_log` (migration 065) is append-only and service-role-written.
- The sidebar is a static array, `navGroups` (`sidebar.tsx:117`), so
  hiding sections per account is a one-place change. Nav hiding is
  presentation only — RLS is the authorization.
- WAHA QR connection and Google OAuth both need an end-user action (scan /
  consent) that a remote operator can't perform themselves.

## Proposed change

### 1. Memberships: many accounts per user, one *active*

Keep `profiles.account_id/account_role` as the **active context** so every
existing RLS policy and `getCurrentAccount()` keep working untouched — the
smallest possible blast radius on a 100-table schema. Add the source of
truth for *which accounts a user may act in*:

```sql
CREATE TABLE IF NOT EXISTS account_memberships (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role account_role_enum NOT NULL,
  kind text NOT NULL DEFAULT 'member' CHECK (kind IN ('member','operator')),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_id),
  -- An operator can never be the owner of a client's account; ownership
  -- stays with (or is transferred to) the client.
  CHECK (kind <> 'operator' OR role IN ('admin','agent','viewer'))
);
-- Backfill: one 'member' row per existing profile, mirroring
-- (account_id, account_role). Keeping the two in step is the job of the
-- RPCs below AND a trigger on profiles (so redeem_invitation / member
-- removal keep working unmodified).
```

RLS: a user can `SELECT` their own memberships; **no client writes** —
everything goes through `SECURITY DEFINER` RPCs (same pattern as
migrations 018-020).

RPCs:

- **`switch_account(p_account_id)`** — verifies a membership exists, then
  in one statement sets `profiles.account_id/account_role` from it and
  writes `audit_log` (`operator.account_switch`, both account ids). The
  client hard-navigates to `/dashboard` afterwards (drops every Realtime
  subscription and cache keyed to the previous account — do **not** try to
  hot-swap in place).
- **`grant_operator_access(p_account_id, p_email, p_role)`** (owner of the
  target account) and **`accept_operator_grant(token)`** — consent-based:
  the **client owner invites the operator**, mirroring the existing
  invitation flow but creating a membership *without moving the profile*.
- **`create_client_account(p_name)`** (operator) — creates an account
  seeded like signup does (default pipeline etc.), the operator as its
  initial `owner_user_id` (the column is NOT NULL) with a `kind =
  'operator'` admin membership, and records `managed = true`. When the
  client later signs up and joins via the normal invitation, the operator
  uses the **existing ownership transfer** to hand ownership over.
- **`revoke_operator_access(p_account_id, p_user_id)`** — the client owner
  can remove an operator at any time, effective immediately (if it was
  their active account, `profiles` reverts to their home account).

Role in a client account is capped at `admin`; `canDeleteAccount` /
`canTransferOwnership` stay owner-only, so an operator can operate but
cannot delete the client's account or lock the owner out.

**Transparency to the client.** Operator rows appear in Settings →
Members with an "Operador" chip and their grant date; every
`operator.account_switch` is visible to the client's admins through the
existing audit log. (Operators read a client's customers' messages — under
LGPD the operator is a *processor*; the docs should say so and this is why
the trail matters.)

### 2. Account switcher + persistent banner

- A switcher in the sidebar's account strip (`sidebar.tsx` shows the
  account name when it differs from the user's) listing memberships;
  selecting one calls `switch_account` and reloads.
- While the active membership is `kind = 'operator'`, a slim persistent
  banner: "Operando: Barbearia X · [Voltar para minha conta]". Wrong-
  account mistakes (sending a message as the wrong business) are the
  worst failure of this feature; the banner is the mitigation.
- **Tab hazard, stated plainly:** the session is shared across tabs, so
  switching in tab B changes what tab A's *next* query sees, while tab A
  still shows the old business. Two guards: (a) API routes compare an
  `x-wacrm-account` header the client sends against
  `profiles.account_id` and reject a mismatch (`account_mismatch`) —
  covers every `/api/**` write; (b) for browser-direct RLS writes (inbox
  status/assign) the client subscribes to its own `profiles` row and, on
  an account change, shows a blocking "A conta ativa mudou em outra aba —
  recarregar" dialog. (b) is best-effort — that residual window is why the
  model is "one active client at a time".

### 3. Portfolio ("Carteira")

`/operator` (only for users with ≥1 `operator` membership), fed by one
`SECURITY DEFINER` RPC **`operator_portfolio()`** that returns, for
accounts where `auth.uid()` holds an operator membership and *only*
those, counts and health — never rows of customer data:

- WhatsApp: Cloud API configured? each WAHA channel `status`
  (`connected|connecting|disconnected`) and `connected_at`;
- AI: configured / auto-reply on / open handoffs / open human cases;
- traffic: last inbound at, conversations awaiting reply, unread;
- agenda: appointments today; Google connection status
  (`needs_reauth` is an alert);
- cost: AI tokens this period (`ai_usage_log`).

Sorted by "needs attention" (disconnected number, `needs_reauth`, no
inbound in 24h on an active number). This is the operator's actual
product: knowing a client's WhatsApp dropped **before** the client does.
Optional later: a push/notification to the operator when a client's
channel disconnects (`sendPushToAccount` already exists).

### 4. "Essential" experience for managed clients

`accounts.ui_profile text NOT NULL DEFAULT 'full' CHECK (ui_profile IN
('full','essential'))`. For **non-operator** members of an `essential`
account, `navGroups` shows only Inbox, Agenda, Contacts (and Settings →
Profile); Pipelines, Automations, Flows, Broadcasts, AI and most Settings
sections are hidden. This is *presentation*, not security (URLs still
resolve; RLS and roles are the authorization) — say so in the UI copy and
the code comment. Operators always see the full app. The client owner can
switch to `full` themselves.

### 5. Remote connect links (the client does the one human step)

Generalizes the "connect link" mentioned in `google-calendar-sync.md`:

```sql
CREATE TABLE IF NOT EXISTS connect_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('whatsapp_qr','google_calendar')),
  target_id uuid,                      -- waha channel id / connection scope
  token_hash text NOT NULL UNIQUE,     -- SHA-256; the token is shown once
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
```

- An admin/operator generates a link ("Enviar para o cliente conectar o
  WhatsApp"); it opens a public page `/connect/[token]` with no login.
- **`whatsapp_qr`**: the page polls the existing QR endpoint for that
  channel and shows it; the client scans with their phone; the page flips
  to "Conectado". A WhatsApp QR is a full credential for that number, so
  the token is treated like a password: 30-minute expiry, single active
  page, rate-limited, never logged, revoked once the channel connects.
- **`google_calendar`**: starts the OAuth flow bound to the link's account
  (the operator never sees the client's Google password).
- Same-origin CSP `report-only` header already covers the new page; add it
  to the middleware public-path list deliberately (it's an intentional
  unauthenticated surface — review as one).

## Acceptance criteria

- [ ] A user with memberships in accounts A (member) and B (operator) can
      `switch_account` between them; after the switch every existing page
      shows only that account's data and RLS blocks the other's.
- [ ] `operator_portfolio()` returns rows only for accounts where the
      caller has an operator membership, and contains no message/contact
      content (asserted by a test that inserts PII and checks the output).
- [ ] An operator membership can never hold `owner`; an operator cannot
      delete the account, transfer ownership, or remove the owner.
- [ ] The client owner can revoke operator access; the operator loses it
      immediately, including when it was their active account.
- [ ] Every switch writes an `audit_log` row visible to the target
      account's admins.
- [ ] While operating a client, the banner is always visible; an API write
      from a stale tab returns `account_mismatch` and changes nothing.
- [ ] In an `essential` account, a non-operator member sees only the
      reduced navigation; an operator sees everything.
- [ ] A connect link works once for the client, expires, and cannot be
      reused after the channel connects; a wrong/expired token reveals
      nothing.
- [ ] Existing single-account users see **no change** (one backfilled
      membership, no switcher, no banner, no portfolio).
- [ ] Migration backfills memberships and `verify-schema.sql` asserts the
      tables, CHECKs, and that `profiles` ↔ membership stay consistent;
      all four locales updated.

## Risks / open questions

- **This touches the tenancy core** (`profiles`/`is_account_member`). The
  chosen design leaves those untouched, but it creates a second source of
  truth (memberships vs the active profile row) that must never drift —
  hence the sync trigger and a consistency assertion in CI.
- **Wrong-account writes** (the tab hazard) are the real danger. The banner
  + header check reduce it; they don't eliminate the browser-direct RLS
  window. A stronger fix (account in the URL, `/a/[id]/...`) would be a
  large refactor; rejected for v1, worth revisiting if operators report
  mistakes.
- **LGPD position.** The operator processes the client's customers' data.
  Ship a short operator-agreement note in the docs and keep the audit
  trail honest; do not add any path that hides an operator from the
  client's member list.
- **`owner_user_id` NOT NULL** forces the operator to own a fresh client
  account until transfer. Acceptable, but a client who never signs up
  leaves the operator as owner indefinitely — surface "propriedade ainda
  não transferida" in the portfolio.
- **Barbershop staff.** The barbers are *users* only if they get seats.
  A "resource without login" concept (see `google-calendar-sync.md`) is
  probably the next step for that customer and is not designed here.
- **Alternative considered: impersonation sessions** (deskcomm's
  `impersonate` + time-boxed support sessions). Simpler for one-off support
  but wrong for an operator who lives in client accounts daily; a TTL that
  auto-reverts the active account could still be added on top.
- **Alternative considered: separate install per client** — deskcomm's own
  doctrine ("misturar clientes numa VPS mistura número, marca e risco").
  Stronger isolation but N deploys, N databases; the multi-tenant model is
  cheaper at small scale. The trade-off should be an explicit product
  decision, not an accident of this spec.
