# Spec: Responsive layout audit across breakpoints

## Problem

Several pages assume a fairly wide viewport and were built/verified at
a single desktop width. Confirmed today while testing an unrelated fix:
`/inbox` at ~800px viewport width showed the conversation list but
never opened the message thread on click — the two-pane layout
apparently needs a wider breakpoint than the browser pane's default to
render correctly, and there was no visible fallback/mobile view at
that width. This needs a systematic pass, not a one-off fix, since it
was found incidentally rather than through a deliberate check.

## Non-goals

- A design-system rewrite or introducing a new breakpoint scale — audit
  against the Tailwind breakpoints already in use (`sm`/`lg` show up
  throughout, e.g. `message-thread.tsx`'s comments reference "mobile
  only. Hidden on lg+").
- Native mobile app / PWA considerations — this is about the existing
  responsive web layout, not a separate mobile experience.

## Current behavior

- `src/app/(dashboard)/inbox/page.tsx`: conversation list vs. thread
  vs. contact panel visibility is already conditionally toggled with
  `hidden lg:flex` / `hidden lg:block` patterns (see the `hasActiveConv
  ? "flex" : "hidden lg:flex"` and contact-panel `hidden lg:block`
  around lines 605-634) — so there IS a mobile-vs-desktop split
  designed in, but it was observed not working correctly at some
  in-between width during manual testing (tab title showed
  "Caixa de entrada" with only the conversation list rendered, clicking
  a conversation did nothing until the viewport was widened to 1400px).
- `src/components/inbox/message-thread.tsx` has a code comment
  (~line 906-913) about a specific overflow bug already fixed
  ("a single wide message... expands the whole thread past its flex
  share," issue #257) — i.e. this area has a history of exactly this
  class of bug, not a one-time miss.
- Dashboard, Settings, Pipelines, Flows pages haven't been specifically
  checked at intermediate widths (this spec's job, not yet done).

## Proposed change

1. Systematically test each top-level page
   (`/dashboard`, `/inbox`, `/contacts`, `/pipelines`, `/flows`,
   `/automations`, `/broadcasts`, `/settings`) at a fixed set of
   viewport widths — at minimum 375px (phone), 768px (tablet),
   1024px (the `lg:` breakpoint boundary itself — the most likely
   place for an off-by-one gap), 1280px, 1440px+.
2. For `/inbox` specifically: reproduce the exact reported bug (list
   renders, clicking a row doesn't open the thread) at the width it
   occurred and find which conditional class is responsible — likely a
   `lg:` gate on the thread pane that should be a narrower breakpoint,
   or a missing state transition when `hasActiveConv` flips at a width
   where the list pane hasn't yet collapsed.
3. Fix each finding as its own small, verifiable change (this spec's
   acceptance criteria should be checked page-by-page, not as one
   giant PR) — mirrors how the rest of this backlog has been worked
   (one fix, one commit, verified before moving on).

## Acceptance criteria

- [ ] `/inbox` at 768px–1023px: clicking a conversation opens the
      thread (the specific bug that surfaced this spec).
- [ ] Every top-level page renders without horizontal scroll or
      overlapping elements at 375px, 768px, 1024px, 1280px.
- [ ] No page's action buttons/menus become unreachable (off-screen,
      zero-width) at any tested width.
- [ ] Existing `hidden lg:*` / `sm:*` responsive comments/history
      (issue #257, #165, #258 in `message-thread.tsx` and
      `inbox/page.tsx`) are re-verified as still correct, not just
      assumed still-fixed.

## Risks / open questions

- Decide the tooling: manual pass with the browser pane's viewport
  presets (mobile/tablet/desktop + custom sizes, already available) is
  sufficient for a one-time audit; a Playwright/visual-regression suite
  would catch future regressions but is a bigger investment than this
  spec's scope.
- The `/inbox` bug in particular may indicate the breakpoint boundary
  itself needs to change (e.g. `lg:` → `xl:` for the three-pane split)
  rather than a bug in the conditional logic — confirm which before
  implementing.
