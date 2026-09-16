# Spec: <short title>

> Copy this file to `specs/<kebab-case-name>.md` before starting a
> feature or non-trivial fix. Fill in every section below; delete
> this comment block. A spec is a gate, not paperwork — skip it for
> typos, copy tweaks, or one-file bug fixes.

## Problem

What's broken or missing, for whom, and why it matters. Link the
issue/conversation that surfaced it if there is one.

## Non-goals

What this spec deliberately does NOT cover, so scope doesn't creep
mid-implementation.

## Current behavior

How it works today — file paths, the relevant flow, the specific
lines that need to change. This is where you prove you've actually
read the code, not just the symptom.

## Proposed change

The approach, in enough detail that someone else could implement it.
For anything touching schema/RLS: call out the migration number, the
exact DDL, and which policies/RPCs are affected.

## Acceptance criteria

- [ ] Bullet list of checkable outcomes. "The X page shows Y" not
      "X is improved."

## Risks / open questions

Anything you're unsure about — ask before implementing, don't guess
silently on a decision that's expensive to reverse (schema changes,
RLS, anything touching money or auth).
