# Spec: Localize automation step-result detail strings

**Status: implemented — Option A, and widened beyond the two
originally-named cases.** A repo-wide grep of `engine.ts` (the
Non-goals section flagged this as a possibility) turned up 20
hardcoded-English `detail` sites across `runStep`'s switch, not just
`wait`/`condition` — every send/tag/assign/field/deal/webhook/close
step returned its own interpolated string. All 20 were converted.

`AutomationLogStepDetail` (`src/types/index.ts`) is `{ key: string;
params?: Record<string, string | number> }`; `AutomationLogStepResult
.detail` is now `string | AutomationLogStepDetail` — the `string` arm
is the legacy shape, rendered verbatim for old rows exactly as this
spec's acceptance criteria required. `StepRow` in
`src/app/(dashboard)/automations/[id]/logs/page.tsx` translates known
keys via the new `Automations.logs.stepDetail.*` namespace (all four
locales); the `wait` step's `unit` param is itself resolved through
`Automations.builder.config.units.*` (the same catalogue the step
config form already uses) rather than being a second translation
layer. `src/lib/automations/engine.test.ts` covers `wait`, `condition`,
and one `update_contact_field` case end-to-end through
`runAutomationsForTrigger` — doing so required teaching the file's
`automation_steps` mock to actually respect `parent_step_id`/`branch`
filters (it previously echoed every step back unfiltered, which is
harmless for a root-only step but would have made the condition
test's branch recursion loop forever matching itself as its own
child).

## Problem

The automation execution log (`/automations/<id>/logs`, expanded row)
shows a per-step `detail` string. Two of these are hardcoded English,
generated in `src/lib/automations/engine.ts`:

- line ~300: `` `waiting ${cfg.amount} ${cfg.unit}` ``
- line ~315: `` `branch=${taken ? 'yes' : 'no'}` ``

Unlike the notification content (see
`specs/i18n-notification-content.md`), these are NOT stored
separately from the log row's own JSON blob at write time in a way
that's trivially re-renderable — `steps_executed` is a JSONB array on
`automation_logs`, and `detail` is one field inside each step result
object. Confirm the exact shape of `AutomationLogStepResult` (`@/types`)
before starting.

## Non-goals

- Rewriting the automations engine's execution model. This only
  changes how `detail` text is produced.
- Any step type not currently emitting a hardcoded string (most step
  types likely have empty/no detail — verify with a repo-wide grep for
  `detail:` in `engine.ts` before assuming these are the only two).

## Current behavior

- `src/lib/automations/engine.ts` builds `detail` as a plain
  interpolated English string and writes it into the step-result JSON
  that ends up in `automation_logs.steps_executed`.
- `src/app/(dashboard)/automations/[id]/logs/page.tsx`'s `StepRow`
  renders `result.detail` verbatim (already fixed to translate
  `result.step_type` via `Automations.builder.steps.*` — see commit
  `5015b29`'s follow-up i18n commit — but `detail` itself is still
  raw).

## Proposed change

Two viable approaches — pick one after checking whether `engine.ts`
has access to a translator at execution time (it runs server-side, no
request context, but the app is single-locale build-time, so it CAN
import `messages/<NEXT_PUBLIC_APP_LOCALE>.json` directly the same way
`src/i18n/request.ts` does):

**Option A (matches the notification spec's philosophy — store
structure, translate at render):** Change `detail` from a string to a
small structured payload, e.g. `{ key: 'waiting', amount, unit }` /
`{ key: 'branch', taken: boolean }`. Update `StepRow` to translate
known `key`s via a new `Automations.logs.stepDetail.*` message
namespace, falling back to rendering the raw payload as JSON (or
omitting it) for unknown keys. Requires a data-shape change to
whatever gets written into `steps_executed` going forward; old log
rows keep their old string shape — `StepRow` needs to handle both
(`typeof result.detail === 'string'` → render as-is;
`typeof result.detail === 'object'` → translate).

**Option B (simpler, less correct):** Have `engine.ts` import the
locale's message catalogue directly (same pattern as
`src/i18n/request.ts`) and build the already-translated string at
write time. Simpler to implement, but bakes today's locale into old
log rows forever — same limitation the notification content has
today, which is the thing prompting this cleanup in the first place.
Only worth it if Option A's data-shape migration is judged not worth
the effort for a detail line that only shows in an expanded log row.

Recommendation: Option A, for consistency with the notification fix
and because it doesn't freeze historical logs in whatever locale was
active when they ran.

## Acceptance criteria

- [ ] A `Wait` step's log entry shows a translated duration (e.g. "2
      horas" in pt) instead of "waiting 2 hours".
- [ ] A `Condition` step's log entry shows a translated branch label
      instead of "branch=yes"/"branch=no".
- [ ] Old log rows (string `detail`) still render without crashing.
- [ ] `npm test` passes, including any new/updated
      `src/lib/automations/engine.test.ts` coverage for the changed
      `detail` shape.

## Risks / open questions

- Confirm nothing else reads `steps_executed[].detail` as a plain
  string (e.g. an export, a webhook payload, the public API) before
  changing its shape — grep for `.detail` usage beyond the logs page.
- Lower priority than the notification fix: this is inside a
  collapsed/expanded log row, not a first-screen UI element like the
  dashboard or notifications list.
