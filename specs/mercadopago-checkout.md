# Spec: Paid signup with Mercado Pago (Pix Automático + card)

**Status (2026-10-06): proposed, not built.** Narrows
`specs/billing-subscriptions.md` (which stays the generic exploration):
processor chosen = Mercado Pago, billing is Brazil-only, and payment is part
of the signup flow, not a later Settings screen. Nothing here ships before
the open questions at the bottom are answered.

## Problem

The marketing page (`src/components/landing/landing.tsx`) now sells three
plans — monthly or annual, paid by Pix or card — but `/signup` creates an
account with no payment, and every account gets every feature forever. The
page promises:

- **Monthly:** charged every month, Pix recurring or card.
- **Annual:** 10 months of price spread over 12 monthly charges (so
  Essencial annual = R$ 164,17/mês), also Pix or card. Nothing is charged
  upfront, so cancelling just stops future charges.
- **No automatic free trial.** A trial is a demo the team grants after the
  visitor asks on WhatsApp.
- Cancel any time; access runs to the end of the paid period.

Terms of use (`/termos`) already state this. The product has to make it true.

## Non-goals

- Upgrades/downgrades between plans (second stage; cancel + resubscribe in
  the meantime).
- Per-seat or usage metering, tax documents (NFS-e), boleto.
- Charging the WhatsApp/Meta message fees — Meta bills those to the
  customer's own account.
- Gating existing accounts retroactively (see "Exempt accounts").

## Flow

```
landing "Assinar X" ─▶ /signup?plano=&ciclo=&pagamento=
   1. name, e-mail, password  (+ accept Terms/Privacy)       [today]
   2. e-mail verification                                      [today]
   3. /onboarding/welcome: company name + context questions    [extend, below]
   4. /onboarding/payment: Mercado Pago checkout               [new]
   5. webhook confirms ─▶ subscription active ─▶ rest of onboarding
```

Payment sits after the welcome step on purpose: by then we have the company
name for the invoice description and the person has invested a minute, but
nothing else of the wizard (channel, AI, team) runs unpaid.

Invited members (`/join/<token>`) skip payment: they enter an account that
already pays.

### Welcome step: company context

`src/app/onboarding/welcome/page.tsx` only asks for the account name today
(the wizard in `specs/signup-onboarding-wizard.md` is implemented for
channel / AI / team / notifications; the "understand the company's moment"
questions were never built). Add, all optional except the name:

- Segment (barbearia/clínica, e-commerce, serviços, educação, outro).
- Team size (1, 2–5, 6–20, 20+).
- Main goal (atender, agendar, vender, prospectar, disparos).
- How many WhatsApp conversations per day.
- Already uses another CRM?

Stored in `accounts.onboarding_state.profile` (jsonb already exists, migration
067 — no new column). Used to pre-select which wizard steps to emphasise
and, later, to qualify leads. The plan chosen on the landing is only a
preselection here; the person can still change it on the payment step.

## Data model (new migration; extend `supabase/ci/verify-schema.sql`)

- `accounts.plan` text (`essencial|profissional|escala|custom`),
  `accounts.subscription_status`
  (`pending|active|past_due|canceled|exempt`), default `pending` for
  accounts created after this ships, `exempt` for every account that exists
  at migration time (Nordia, Barbearia test account, any dev account).
- `billing_subscriptions`: `account_id` unique FK, `provider='mercadopago'`,
  `mp_preapproval_id`, `mp_payer_id`, `cycle` (`monthly|annual`),
  `method` (`pix|card`), `amount_cents`, `current_period_end`,
  `canceled_at`, `grace_until`, timestamps.
- `billing_events`: `mp_event_id` **unique** (idempotency key), `type`,
  `raw jsonb`, `processed_at`. Written only by the webhook.
- RLS: members read `billing_subscriptions` of their account; **no client
  writes at all**. Every write goes through `supabaseAdmin()` in the webhook
  / checkout routes, owning the `account_id` filter by hand (CLAUDE.md,
  "Three auth paths").

## Mercado Pago integration

Applications (created by the account owner): `nordia-crm-assinaturas`
(Subscriptions, card) and `nordia-crm-checkout-transparente` (Checkout
Transparente, Pix, Orders API). Each has its own credentials and webhook
secret, so env vars are per application (`MERCADOPAGO_SUBS_*`,
`MERCADOPAGO_PIX_*`) and the webhook picks the secret by which app signed.

- Module `src/lib/billing/` with an adapter interface and a
  `mercadopago.ts` implementation (like `src/lib/ai/providers/`), so the
  routes never import the SDK directly.
- **Card:** Subscriptions API (`preapproval`), card tokenised in the browser
  by Mercado Pago's own JS (Secure Fields / Brick). The card number never
  touches our server or logs.
- **Pix (researched 2026-10-06):** Mercado Pago's Subscriptions API
  (`POST /preapproval`) is **card-only** — its docs state Pix is not
  supported there. Pix Automático exists as a Mercado Pago product, but no
  developer API for it was found in the public docs, and it requires an
  active CNPJ older than 6 months. Until that is confirmed with Mercado
  Pago (support / the app's product list), Pix is implemented as a
  **monthly one-off Pix charge** through Checkout Transparente, using the **Orders API** (the Payments API is being discontinued, per the account owner; confirm the exact request shape in the sandbox) (QR code +
  copia e cola on our own screen), generated by a cron before each due
  date, with a reminder message; access follows `subscription_status`:
  paid = `active`, unpaid after the grace window = `past_due`. Cancelling
  just stops generating charges. Switch to Pix Automático only if/when its
  API is confirmed.
- **Card without redirect:** Card Payment Brick tokenises the card in the
  browser; the server creates the subscription with
  `POST /preapproval { card_token_id, payer_email, reason, status:
"authorized", auto_recurring {frequency:1, frequency_type:"months",
transaction_amount, currency_id:"BRL", start_date, end_date}, back_url }`.
  Failed charges retry up to 4 times in 10 days (`recycling`). Webhook
  topic: `preapproval.updated` (plus payment notifications).
- **Annual billed monthly** is a monthly subscription at
  `round(price × 10 / 12, 2)` with a 12-charge cap; the landing and the
  checkout must use the same function (extract it into
  `src/lib/billing/plans.ts` and import it in the landing too, so the page
  and the charge can never disagree).
- Prices live server-side in `src/lib/billing/plans.ts`. The client sends
  `{plan, cycle, method}` only; **never an amount**.

### Routes

- `POST /api/billing/checkout` — `requireRole('owner')`; validates input,
  computes the amount from the server table, creates the preapproval with
  `external_reference = account_id`, returns the redirect/Pix authorisation
  data. Rate limited (`lib/rate-limit.ts`).
- `POST /api/billing/webhook` — public, signature-verified (below).
- `POST /api/billing/cancel` — `requireRole('owner')`; cancels the
  preapproval at Mercado Pago, sets `canceled_at`, keeps access to
  `current_period_end`.
- `GET /api/billing/status` — for the payment screen to poll while the
  webhook is in flight.

## Security requirements

These are acceptance criteria, not suggestions.

1. **Verify the webhook signature.** Mercado Pago sends `x-signature`
   (`ts=…,v1=…`) and `x-request-id`; recompute HMAC-SHA256 over
   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` with the webhook
   secret, compare with `timingSafeEqual`, reject if `ts` is older than 5
   minutes. Same shape as `src/app/api/whatsapp/webhook/route.ts` and the
   cron route.
2. **Never trust the payload.** The webhook only carries an id; fetch the
   payment/preapproval from the Mercado Pago API with our access token and
   act on _that_ response. A forged request that passes nothing useful
   cannot flip a subscription.
3. **Idempotent.** Insert into `billing_events` with the unique `mp_event_id`
   first; a duplicate delivery is acknowledged and ignored (Mercado Pago
   retries). State changes are monotonic by event time so an out-of-order
   `past_due` cannot overwrite a newer `active`.
4. **Amount and account are server-decided.** On every confirmation compare
   the paid amount with the expected amount for the stored plan/cycle, and
   resolve the account only from our own `billing_subscriptions` row
   (looked up by preapproval id), never from a client-supplied id.
5. **Secrets only in env vars:** `MERCADOPAGO_ACCESS_TOKEN`,
   `MERCADOPAGO_WEBHOOK_SECRET`, public key `NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY`.
   Not in the repo, not in logs, not in chat. Sandbox and production keys
   in separate Vercel environments.
6. **No card data stored or logged**; error logging redacts request bodies
   of the billing routes.
7. **Only the owner** can start or cancel a subscription; other roles see
   plan and renewal date (new capability predicates in
   `src/lib/auth/roles.ts`, no open-coded role checks).
8. **Pending ≠ paid.** Returning from the payment screen never activates
   anything; only the verified webhook does.

## Gating and suspension

- `pending`: can log in and finish the wizard up to the payment step; the
  dashboard redirects to `/onboarding/payment`. No WhatsApp send, no AI.
- `active` / `exempt`: full access.
- `past_due`: banner and 7 days of full access, then read-only
  (`grace_until`); data never hidden.
- `canceled`: access until `current_period_end`, then read-only for 30 days,
  then the deletion described in `/privacidade`.
- Enforcement in one place: a `canUseApp(account)` predicate used by the
  middleware/dashboard layout and by the send/AI API guards. Engines using
  `supabaseAdmin()` (flows, automations, prospecting) must check it too, or
  an unpaid account keeps sending through them.

## Exempt accounts

Every account existing at migration time becomes `exempt`. The Nordia Tech
and Barbearia Navalha accounts must never be touched by the checkout
tests; all payment testing uses a _new_ account created for the purpose and
Mercado Pago's **sandbox** credentials and test users/cards.

## Test plan

1. Unit: signature verification (valid, wrong secret, stale `ts`, tampered
   id), idempotent event handling, price function (annual = 10/12),
   status transitions including out-of-order events.
2. Sandbox end to end with a fresh account: card approved, card rejected,
   Pix Automático authorised, cancel, simulated failed charge → `past_due`
   → grace → read-only.
3. Negative: forged webhook, replayed webhook, client sending a different
   amount/plan, non-owner calling checkout, `pending` account hitting a
   send endpoint.
4. Only then production keys, with a real R$ 1 test subscription, refunded.

## Order of work

1. Welcome-step context questions (no money involved; can ship alone and be
   tested right away).
2. Migration + `lib/billing` (plans, status predicate, webhook verification)
   with unit tests.
3. Checkout and webhook routes, payment step in the wizard, sandbox tests.
4. Gating + Settings > Billing panel (plan, renewal, cancel).
5. Landing: import prices/annual function from `lib/billing/plans.ts`.

## Open questions (need the account owner)

- Does the Mercado Pago business account have Pix Automático enabled, and is
  it available through the same API as card subscriptions? (Owner believes
  yes; confirm in the sandbox before building around it.)
- Real company data for invoices and the legal pages (CNPJ, legal name).
- What happens to accounts that stop paying beyond the 30-day read-only
  window: delete, or keep archived?
- Plan limits (numbers, users, agents) listed on the landing are marketing
  copy today; decide which are enforced at launch.
- Migration and the Mercado Pago credentials need explicit go-ahead before
  anything is applied or configured.
