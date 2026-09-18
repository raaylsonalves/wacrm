# Spec: Account branding (logo, name, custom color)

**Status: implemented.** Migration `044_account_branding.sql` added
`display_name`/`logo_url`/`brand_color` to `accounts`.
`src/components/settings/branding-settings.tsx` is the admin-only
Settings → Branding panel (logo upload, display name, hex color
picker). `src/components/layout/brand-color-effect.tsx` applies
`brand_color` at runtime via `--primary`/`--primary-foreground` (and
the derived hover/ring tokens), computing contrast with
`getContrastForeground()` in `src/lib/color-contrast.ts` exactly as
the "Decisions" section below specifies — no second color picker, no
curated palette. `sidebar.tsx` reads `account?.display_name` with a
fallback to the translated default name, and the default icon/name
render unchanged for an account with nothing configured. The `<title>`
question was resolved by taking the simpler option: the browser tab
title stays the static "wacrm" from `layout.tsx`'s metadata; it is not
overridden client-side per account.

## Problem

Every visual identity element is currently hardcoded at the template
level, not customizable per deployment or per account:

- The app name is a literal string, `"wacrm"`, baked into
  `src/app/layout.tsx`'s `metadata.title` (browser tab / page title)
  and into `src/components/layout/sidebar.tsx`'s logo row via
  `t("title")` (a translation key, not account data — same English
  word in every locale).
- The sidebar "logo" is a hardcoded Lucide `MessageSquare` icon in a
  colored box (`sidebar.tsx` ~line 191) — no image, no way to swap it
  for a company logo.
- Color choice is limited to 5 fixed accent themes
  (`src/lib/themes.ts`'s `THEME_IDS`) plus light/dark mode. Both are
  **per-browser** (`localStorage`, `wacrm.theme` /
  `wacrm.mode` keys) — a per-user preference, not a company brand
  color, and not shareable: every teammate who logs in sees whatever
  they personally picked, not the company's brand.

For an operator running this CRM under their own company name for
their own team (or an agency running it for a client), there's no way
to make the product look like "their" tool instead of "wacrm" with a
message-bubble icon.

## Non-goals

- Multi-domain / custom-domain-per-account. Out of scope — this is
  about visual branding within one deployment, not multi-tenant SaaS
  routing.
- Arbitrary custom CSS or full theme editing (fonts, spacing,
  component-level overrides). Scope is: logo image, display name,
  one primary brand color.
- Per-user override of the account's brand color. If this ships,
  the account's brand color is what everyone in that account sees —
  it replaces the personal theme picker's *default*, but nothing here
  requires removing the existing personal light/dark mode toggle
  (mode stays a legitimate per-user preference; accent color becomes
  account-level).
- Email templates / PDF exports carrying the logo. Only the in-app
  UI (sidebar, header, browser tab) is in scope for a first pass.

## Current behavior

- `src/app/layout.tsx`: static `metadata` object, `title.default =
  "wacrm"`, `title.template = "%s — wacrm"`. Also where favicon /
  `<link rel="icon">` presumably comes from `src/app/favicon.ico` or
  similar static asset (confirm exact file before implementing).
- `src/components/layout/sidebar.tsx` ~lines 189-197: logo box +
  `{t("title")}` inside the `Link` to `/dashboard`. `t("title")` reads
  `Sidebar.title` from `messages/*.json` — currently the literal word
  "wacrm" (or a locale-specific spelling of it) in all four locales.
- `src/components/layout/header.tsx`: check whether the top header
  repeats the same name/logo (likely just the mobile menu trigger +
  user menu — confirm before assuming duplication).
- `src/lib/themes.ts` + `src/app/globals.css`: 5 named `data-theme`
  values, each a block of CSS custom properties (`--primary`,
  `--primary-foreground`, etc.). Applied via an inline boot script in
  `src/app/layout.tsx` (before hydration, to avoid a flash) reading
  `localStorage.getItem('wacrm.theme')`.
- `accounts` table (migration `017_account_sharing.sql`): `id`,
  `name`, `owner_user_id`, timestamps. No branding columns.
- Storage buckets that exist today (per `docs/docker.md` and the
  webhook code): `chat-media` for inbound attachments,
  presumably an `avatars` bucket for profile pictures (confirm exact
  bucket names in a migration before reusing the pattern) — a new
  `account-branding` bucket (or a reused public bucket) would be the
  logo upload target.

## Proposed change

Account-level, not deployment-level: the schema already models
"one team = one account" (migration 017), and a company logo /
brand color is naturally a property of the account, not of the git
checkout. This also means it survives redeploys and works correctly
for an operator running wacrm for multiple client accounts under one
deployment.

1. **Migration `04x_account_branding.sql`**: add nullable columns to
   `accounts`:
   - `display_name TEXT` — shown instead of the account's internal
     `name` when set (keep `name` as the internal/billing name,
     matching how `default_currency` was added in migration 021
     without touching `name`'s existing meaning).
   - `logo_url TEXT` — public Storage URL.
   - `brand_color TEXT` — a single hex color (validate format with a
     `CHECK` constraint, e.g. `brand_color ~ '^#[0-9a-fA-F]{6}$'`).
   RLS: covered by the existing `accounts_select` (member read) /
   `accounts_update` (admin+ write) policies — no new policy needed
   since these are just new columns on an already-policied table.
2. **Storage**: new public bucket (or a folder inside an existing
   public one) for logos, path-scoped by `account_id` the same way
   `chat-media` scopes by conversation. Validate file type (image
   only) and a small size cap (e.g. 2 MB) client-side before upload —
   mirror whatever pattern `avatars` already uses if one exists.
3. **Settings → Branding panel** (new tab in `settings-sections.ts` +
   a `BrandingSettings` component, admin+ only like `DealsSettings`):
   logo upload/preview, display name input, color picker (hex input +
   swatch preview) with a live preview of the sidebar. Same
   admin-gate pattern as `deals-settings.tsx`
   (`accounts_update` requires admin+, so non-admins see a
   disabled/read-only view).
4. **Rendering**: `sidebar.tsx` and anywhere else `t("title")` /
   the hardcoded icon appears reads the current account's
   `display_name` / `logo_url` (falls back to the translated default
   name and the `MessageSquare` icon when unset — so a fresh account
   with no branding configured looks exactly like today). `brand_color`
   becomes a 6th, dynamic entry in the theme system: either (a) inject
   it as an override CSS custom property scoped to `[data-theme]` at
   runtime once the account loads, or (b) add it as a proper
   `THEME_IDS` entry generated from the one color (needs a plan for
   deriving `--primary-foreground` contrast — see Risks). Prefer (a)
   for a first pass: simpler, and doesn't require solving automatic
   foreground-contrast generation.
5. **`<title>` / metadata**: `layout.tsx`'s static `metadata` export
   can't read account data (no request-scoped account at that layer
   per this repo's own architecture doc — every account-aware read
   happens client-side). Either accept that the browser tab title
   stays "wacrm" (document metadata is genuinely deployment-level,
   which is a reasonable line to draw), or set `document.title`
   client-side from a top-level effect once the account loads — pick
   one explicitly rather than leaving it ambiguous.

## Acceptance criteria

- [ ] An admin can upload a logo, set a display name, and pick a
      brand color in Settings → Branding.
- [ ] Every member of that account sees the custom logo/name/color in
      the sidebar immediately (no per-user opt-in needed) — a
      non-admin can view but not edit these fields.
- [ ] An account with nothing configured renders exactly as today
      (default icon, translated "wacrm" name, default theme) — no
      regression for existing forks that don't use this feature.
- [ ] `brand_color` rejects malformed input (RLS/DB `CHECK` plus
      client-side validation) rather than silently breaking the UI.
- [ ] `npm test` — a new `src/lib/.../branding.test.ts` (or wherever
      the validation helper lives) covers the hex-color validator.
- [ ] `supabase/ci/verify-schema.sql` gets a check for the new
      columns, following the pattern used for migrations 040/042.

## Decisions

- **Contrast**: auto-compute `--primary-foreground` from
  `brand_color` via relative luminance (WCAG formula) — pick black or
  white, whichever contrasts more. No second color picker, no curated
  palette. A `getContrastForeground(hex): '#000000' | '#ffffff'`
  helper, unit-tested with known light/dark hexes. Accepted trade-off:
  a pastel brand color will read as "technically passable, a bit flat"
  against pure black/white rather than a hand-tuned near-white — fine
  for a v1, revisit only if real feedback says otherwise.
- **Flash of default branding**: don't solve it. No `localStorage`
  caching keyed by account id — the branding swap (default icon/name →
  custom logo) is a low-stakes, sub-second flash once per session,
  unlike the light/dark flash the theme boot script exists for (which
  is jarring precisely because it inverts the whole page's contrast).
  Render the default, swap in place once the account loads, exactly
  like every other account-scoped value already on this page
  (currency, member list, etc.).

## Risks / open questions

- **Logo upload abuse**: any admin can upload arbitrary images to a
  public bucket — confirm file-type/size validation happens
  server-side too (Storage bucket `file_size_limit` +
  `allowed_mime_types`), not just client-side (client checks are
  bypassable).
- `header.tsx` confirmed to carry no duplicate logo/name render —
  `sidebar.tsx` is the only site.
