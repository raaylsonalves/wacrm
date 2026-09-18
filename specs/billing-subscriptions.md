# Spec: Recurring billing / subscriptions for the platform

> Exploratory — this captures the shape of the problem and the
> tradeoffs, not a ready-to-implement plan. The "Risks / open
> questions" section has more open items than usual on purpose; several
> of them should be resolved with the account owner before writing any
> code.

## Problem

wacrm has no concept of a paid plan. Every account that exists today
has unlimited access to every feature, forever, for free. There is no
mechanism to:

- charge an account owner on a recurring basis (monthly/yearly),
- gate features or usage by plan tier,
- know when a subscription lapses and downgrade/suspend gracefully,
- let an account see or manage its own billing state.

This matters once the app moves from "a repo you fork and self-host"
(its current framing per `CLAUDE.md` — "a template repository, not a
collaborative product") toward "a product with paying customers" —
either a hosted multi-tenant offering built on top of this fork, or a
paid version an agency resells to its own clients. Either path needs
recurring billing before it needs almost anything else.

## Non-goals

- Picking a final pricing model (per-seat vs. per-conversation vs.
  flat tiers) — that's a business decision for the account owner, not
  an engineering one. This spec assumes tiers exist but stays agnostic
  about what they gate.
- Implementing usage-based metering for every resource (messages sent,
  AI tokens consumed, contacts stored). Start with a binary
  active/inactive subscription; usage-based limits are a natural
  follow-up once the billing plumbing exists.
- Multi-currency / regional tax handling (VAT, Brazil's NF-e, etc.) —
  Stripe Tax or a regional processor can be layered in later; don't
  block the first cut on it.
- Marketplace/reseller billing (an agency sub-billing its own clients
  inside one wacrm instance) — out of scope until single-account
  billing works.

## Current behavior

- **Tenancy**: `account_id` is the sharing key across every table
  (migration `017_account_sharing.sql`). Roles are
  `owner > admin > agent > viewer` (`src/lib/auth/roles.ts`,
  `is_account_member()` SQL helper). There is no `plan`, `status`, or
  `billing_*` column anywhere on `accounts`.
- **Privileged mutations** that RLS can't express already live as
  `SECURITY DEFINER` RPCs in migrations 018–020 (invitation redemption,
  role changes, ownership transfer) — this is the established pattern
  for anything sensitive that needs to run with elevated privilege but
  still be account-scoped.
- **The AI provider is bring-your-own-key** (`src/lib/ai/providers/`):
  each account pastes its own OpenAI/Anthropic/Gemini key, stored
  AES-256-GCM-encrypted under `ENCRYPTION_KEY`
  (`src/lib/whatsapp/encryption.ts` — the same encryption helper is
  reused, not WhatsApp-specific despite the module path). This is the
  closest existing precedent for "a secret an account owns, encrypted
  at rest, checked before a gated action runs."
- **No webhook receiver exists for a payment processor.** The only
  inbound webhook today is `src/app/api/whatsapp/webhook/route.ts`
  (Meta). A Stripe (or equivalent) webhook would be a new, structurally
  similar route: signature verification, then account resolution, then
  a state update — but keyed off a `stripe_customer_id` /
  `stripe_subscription_id` instead of `phone_number_id`.
- **No gating exists anywhere.** Every capability predicate in
  `src/lib/auth/roles.ts` (`canManageMembers`, `canEditSettings`,
  `canSendMessages`, …) is purely role-based, never plan-based.

## Proposed change

1. **Schema** (new migration `051_billing_subscriptions.sql` or later,
   whatever the next free number is at implementation time):
   - `accounts.plan` (`text`, default `'free'` or similar) and
     `accounts.subscription_status`
     (`'active' | 'past_due' | 'canceled' | 'trialing'`, mirrors the
     payment processor's own status enum so translation stays 1:1).
   - A `billing_customers` table: `account_id` (unique, FK), the
     processor's customer id, the processor's subscription id, current
     period end, and timestamps. Keep processor-specific ids in their
     own table rather than bolting them onto `accounts` — makes it
     easier to swap processors later and keeps `accounts` itself
     processor-agnostic.
   - RLS: `billing_customers` readable by the account (any role, so
     the UI can show plan/renewal date) but writable only by the
     webhook handler via `supabaseAdmin()` — mirrors how
     `whatsapp_config` write access is admin-gated while read access
     is broader.
2. **Payment processor integration** — Stripe is the default
   recommendation (Checkout + Billing Portal cover subscription
   creation, upgrades, cancellation, and dunning without wacrm having
   to build any of that UI itself). A new `src/lib/billing/` module,
   structured like `src/lib/ai/providers/`: a thin adapter interface so
   a different processor could be swapped in without touching call
   sites.
3. **Webhook**: `src/app/api/billing/webhook/route.ts` — signature
   verification (Stripe's `stripe-signature` header, analogous to the
   WhatsApp webhook's HMAC check), resolve `account_id` from the
   `stripe_customer_id` on `billing_customers`, update
   `subscription_status` on `invoice.paid` /
   `customer.subscription.updated` / `customer.subscription.deleted`.
   Idempotent on the event id, same rationale as the WhatsApp webhook
   being idempotent on `meta_message_id`.
4. **Gating**: extend `src/lib/auth/roles.ts` (or add a sibling
   `src/lib/auth/plan.ts`) with plan-based predicates
   (`canUseAiAutoReply`, `canCreateBroadcast`, whatever the actual
   tiers gate) called the same way `canEditSettings` etc. are today —
   from both API route guards and UI gates (`useCan`, `RequireRole` →
   maybe a new `RequirePlan`).
5. **UI**: a `Settings > Billing` panel (new `SettingsSection`, follows
   the existing pattern in `src/components/settings/settings-sections.ts`
   /`settings-rail.tsx`) showing current plan, renewal date, and a
   button that opens the processor's hosted billing portal — avoid
   building a custom payment-method-management UI when the processor
   already provides one.
6. **Suspension behavior**: define what happens on `past_due` /
   `canceled` — likely read-only access rather than full lockout, so an
   account doesn't lose visibility into their own data mid-dunning.
   This needs an explicit decision (see open questions).

## Acceptance criteria

- [ ] An account owner can subscribe to a paid plan from within the
      app and land back in wacrm with `subscription_status = 'active'`.
- [ ] Cancelling or letting a subscription lapse (simulated via the
      processor's test-mode webhooks) flips `subscription_status`
      within one webhook round-trip, no polling required.
- [ ] A non-owner account member can see the plan/renewal date but
      cannot change it (mirrors the `owner`-only pattern already used
      for ownership transfer).
- [ ] At least one real capability is gated on plan, end-to-end (API
      guard + UI gate), proving the plumbing works beyond just storing
      a status string.
- [ ] The billing webhook is idempotent and covered by a unit test the
      same way `webhook-signature.test.ts` covers the WhatsApp one.

## Risks / open questions

- **Which processor?** Stripe is assumed above because it's the
  default for a template repo with an international audience, but the
  account owner may have a preference (Brazilian processors like
  Pagar.me/Asaas/Iugu handle PIX/boleto, which Stripe does not
  natively). This changes the adapter's shape enough that it should be
  confirmed before writing code.
- **Free tier or trial-only?** Determines whether `plan = 'free'` is a
  permanent state or whether unpaid accounts eventually get suspended
  outright. Affects the suspension-behavior decision above.
- **Per-seat billing intersects with the existing invitation flow**
  (migrations 018–020) — if the plan is per-seat, inviting a teammate
  needs to check seat count against the plan before the invite RPC
  succeeds, which is a new failure mode that flow doesn't have today.
- **Self-hosted forks**: per `CLAUDE.md`, this is a template repo where
  "divergence in a fork is the point." A self-hoster running their own
  instance for their own team has no reason to pay a subscription to
  themselves — this feature is really for a *hosted* offering built on
  top of the fork. Worth deciding whether billing should be feature-
  flagged off entirely for self-hosted deployments (an env var like
  `NEXT_PUBLIC_BILLING_ENABLED`) so forks aren't shipped with a
  paywall no one asked for.
