# Spec: Resizable contact panel + clearer tag display in the inbox

**Status: implemented.** `src/components/inbox/contact-sidebar.tsx`:
a drag handle on the panel's left border resizes it between
`MIN_PANEL_WIDTH`/`MAX_PANEL_WIDTH`, persisted in `localStorage` under
`wacrm.inboxContactPanelWidth` (`readInitialPanelWidth()`, same lazy-
read pattern as `use-theme.tsx`). Tags get `max-w-[160px] truncate`
plus a native `title` tooltip for the full name. The show/hide toggle
(issue #258) is untouched — resizing and toggling remain independent.
The "+N more" tags pattern from the proposed change wasn't needed in
practice; `flex-wrap` at the wider resizable width was sufficient.

## Problem

`ContactSidebar` (the right-hand contact panel in `/inbox`) is a fixed
`w-70` (280px, `src/components/inbox/contact-sidebar.tsx:130,140`) with
no way to resize it. Tags render as small pills wrapped in a
`flex-wrap` row inside that fixed width (lines 198-214) — with a couple
of tags with longer names, or an account that uses several tags per
contact, the row wraps to multiple lines and eats vertical space that
would otherwise show deals/notes, and tag names longer than the panel
width get visually cramped rather than truncated or laid out
predictably.

## Non-goals

- A general "resizable panes" primitive reused elsewhere in the app —
  scope this to the inbox's contact panel specifically.
- Changing what data the panel shows (deals, notes, tags, custom
  fields) — this is a layout/sizing fix, not a content redesign.
- Fixing arbitrary user-picked tag colors' contrast (see Risks below —
  that's a separate, harder problem from the panel's own sizing).

## Current behavior

- `src/components/inbox/contact-sidebar.tsx:130,140` — root container
  is `w-70` unconditionally, both the empty state and the populated
  state. No `min-w`/`max-w` range, no drag handle, no persisted
  user preference.
- `src/app/(dashboard)/inbox/page.tsx` (~line 628-634): the panel is
  toggled entirely on/off (`contactPanelOpen`) via the thread header
  button (issue #258) but never resized — it's binary, not a spectrum.
- Tags (`contact-sidebar.tsx:198-214`): `flex flex-wrap gap-1`, each
  tag a `rounded-full px-2 py-0.5 text-[10px]` pill colored via inline
  `style={{ backgroundColor: `${tag.color}20`, color: tag.color }}` —
  the tag's own stored hex, not run through any contrast check.
- Same fixed-pill pattern is reused for the deal-stage badge just below
  (line ~248) and in `contact-detail-view.tsx`'s tags tab — worth
  checking both stay visually consistent if this pill style changes.

## Proposed change

1. Make the contact panel's width a draggable range (e.g. 240–420px),
   persisted per-user in `localStorage` (mirrors how `wacrm.theme` /
   `wacrm.mode` are persisted in `src/lib/themes.ts` — same pattern,
   new key e.g. `wacrm.inboxContactPanelWidth`). A simple drag handle
   on the panel's left border is enough; no need for a full resizable-
   panel library given the rest of the app hand-rolls its layout
   primitives.
2. Tags: at a wider panel width, allow more per row before wrapping
   (already responsive via `flex-wrap`, so this mostly falls out of #1
   for free) — additionally consider a max-tags-visible-then-"+N more"
   pattern if an account tags contacts heavily, so the panel doesn't
   grow unboundedly tall from tags alone pushing deals/notes down.
3. Long tag names: add `max-w-[...] truncate` with a `title` attribute
   (native tooltip) so an overlong name degrades to an ellipsis instead
   of wrapping the pill's text awkwardly.

## Acceptance criteria

- [ ] The contact panel can be resized by dragging, within a sane
      min/max, and the chosen width persists across reloads.
- [ ] A contact with 8+ tags doesn't visually crowd out the deals/notes
      sections below it.
- [ ] A single tag with a long name truncates cleanly instead of
      wrapping or overflowing its pill.
- [ ] No regression to the existing show/hide toggle (issue #258) —
      resizing and toggling are independent, orthogonal controls.
- [ ] Verified at both the panel's min and max width, and with the
      inbox's mobile layout (panel hidden entirely below `lg:`) —
      confirm the resize handle doesn't render/interfere there.

## Risks / open questions

- Tag colors are fully user-chosen (`tags.color`, a stored hex) with no
  contrast validation against light/dark mode backgrounds — a user
  picking a very light color for a tag will always render poorly on
  light mode's white card surface, and vice versa on dark mode,
  regardless of this spec's panel-sizing work. Whether to add a
  contrast-safe color picker (e.g. constrain the palette, or compute
  and force a readable text color from the chosen background rather
  than reusing the exact hex for both) is a separate, harder design
  decision worth its own spec if it comes up again.
- Confirm whether `contact-detail-view.tsx`'s tags tab and
  `contact-sidebar.tsx`'s tag pills should stay pixel-identical in
  style, or whether they're allowed to diverge (the sidebar is more
  space-constrained).
