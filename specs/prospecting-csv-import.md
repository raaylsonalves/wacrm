# Spec: Prospecting from a CSV — import, cold outreach by an AI agent, and follow-through in the pipeline

> deskcomm's prospecting (`lib/prospecting/`) is a whole **lead-capture and
> approach flow**, not just an import: it searches a data provider (an
> Apify Google-Maps scraper, by niche + city), turns each business found
> into a contact **and a pipeline deal**, has an **AI agent write a
> personalised first approach**, sends it **slowly** (daily cap, interval
> with jitter, warm-up ceiling for new numbers, an opt-out line on every
> message), lets the **same agent carry the conversation when the person
> replies**, and moves the deal to a *qualified* stage when the criteria
> are met. An earlier draft of this spec only covered the import; that was
> the smallest part.
>
> Decision (user, 2026-09-29): **the source is a CSV the account already
> has** — leads are captured by another route. The data-provider search is
> out of scope; everything after "we have a list of candidates" is the
> same flow as deskcomm's. Two parts:
>
> - **Part A — import** (a port of deskcomm's `POST /api/v1/leads/import`,
>   `lib/leads/planilha.ts`, `lib/contacts/csv.ts`): sections 1–3.
> - **Part B — prospecting campaign** (a port of `lib/prospecting/`
>   minus the provider): section 4. Reuses the WAHA throttle, AI agents,
>   pipelines/deals, `followup-sequences.md`.
>
> The **consent gate** (section 3) is new to wacrm and is what keeps the
> number alive.

## Problem

1. **Today's CSV import is a browser-side, English-only, comma-only
   importer that breaks on the files real people have.**
   `src/lib/contacts/parse-contact-csv.ts` and
   `src/components/contacts/import-modal.tsx`:
   - Header is split with `.split(',')` and the rows with `/\r?\n/` **before**
     quote handling — a spreadsheet saved by Excel in Brazil uses `;` and
     the whole header collapses into one column ("phone column missing");
     a quoted cell containing a line break splits a row in two.
   - Only the exact English headers `phone`, `name`, `email`, `company`,
     `tags` are recognized. `telefone`, `celular`, `whatsapp`, `nome`,
     `empresa` are silently ignored.
   - No encoding handling: Excel exports Latin-1 by default, so "João"
     arrives as "Jo�o".
   - The import loop runs **in the browser tab** (`import-modal.tsx`
     calls `from('contacts')` directly). Closing the tab mid-import leaves
     the file half-imported with no record of which half.
   - Extra columns (cidade, segmento, valor, origem…) are dropped. There is
     no custom-field mapping, no source, no list, and the outcome is a set
     of counts — the user can't see *which rows* failed or why.
2. **There is no notion of "where did this contact come from / may I
   message them".** Every imported contact is indistinguishable from one
   who opted in. For a prospecting list that is dangerous: unsolicited
   first-touch messages are the fastest way to get a Cloud API number
   restricted and a WAHA (unofficial) number banned — and the account has
   no way to see, before sending, that a list was cold.
3. The Broadcast wizard already accepts a CSV audience
   (`step2-select-audience.tsx`, `audience.type = 'csv'`, `phone` + `name`
   only) — a *second* CSV parser (`src/lib/broadcast-csv.ts`) with its own
   limits and no persistence. Two importers with two behaviors is the
   "second truth that ages alone" deskcomm's own comments warn about.

## Non-goals

- **Data providers, scraping, or enrichment APIs** (deskcomm's Apify
  search). Phase 2 at most: a `source` seam on the campaign so a provider
  can feed `prospecting_candidates` later without touching the sender.
- **Cold outreach on the WhatsApp Cloud API.** A first-touch message there
  needs an approved template and opt-in; deskcomm refuses those channels
  for prospecting (`freeformOutsideWindow`) and so does this spec —
  prospecting campaigns run on **WAHA channels only**.
- **Buying/renting lists as a supported flow.** The wizard can *record*
  that a list is third-party — and then blocks sending to it (below) —
  but wacrm will not help send cold marketing to purchased lists.
- **`.xlsx` parsing.** deskcomm deliberately avoided the unmaintained
  `xlsx@0.18.5` (known CVEs) in favor of CSV; keep that decision. The docs
  tell users to "Save as CSV (UTF-8)"; a Latin-1 fallback covers Excel's
  default.
- **Deduplicating against external systems**, or merging two different
  CRM contacts. Only phone-based upsert into this account's contacts.
- **Automatic WhatsApp-number validation on the Cloud API** (impossible
  without sending). An optional WAHA-only check is listed as phase 2.

## Current behavior

- `parseContactCsv()` (`parse-contact-csv.ts:49`): described above;
  `parseCsvLine` handles quotes within one already-split line.
- `import-modal.tsx`: parses in the browser, `dedupeByPhone()` from
  `src/lib/contacts/dedupe.ts` (shared with the webhook and manual form),
  then batches `from('contacts')` inserts/updates from the client and shows
  counts.
- `contacts.opted_out_at` (migration 053) exists and the webhooks set it
  on STOP keywords; broadcasts skip opted-out contacts. There is **no**
  consent/source/basis column.
- Custom fields: `custom_fields` + `contact_custom_values` (migrations
  001/017) are managed in Settings → Fields & Tags but not reachable from
  import.
- Tags drive audiences (Broadcast wizard `audience.type = 'tags'`) and the
  Inbox filter.
- Broadcast sending: `createBroadcast` / `deliverBroadcast`
  (`src/lib/whatsapp/broadcast-core.ts`), WAHA rotation and throttle
  (`claim_waha_send_slot`, migration 064; `broadcast-rotation.ts`).
  Scheduling and sequences are specced but not built.
- deskcomm's reference implementation: `parseCsv` is RFC 4180 with
  delimiter detection (the Excel-in-Portuguese `;`), `decodificarCsv`
  handles Latin-1, header synonyms in pt/es/en (`COLUNAS` in
  `lib/leads/planilha.ts`), a template download, **per-row outcome**
  ("linha inválida é pulada com o motivo nominal"), a row cap, and one
  audit entry for the gesture.

## Proposed change

### 1. One CSV core, shared

`src/lib/csv/` (ported from deskcomm `lib/contacts/csv.ts`): RFC 4180
parser (quotes, embedded newlines, `""` escapes), delimiter detection
(`,` `;` tab), BOM strip, UTF-8 with Latin-1 fallback, hard caps (bytes,
rows). `parseContactCsv` and `parseBroadcastCsv` become thin adapters over
it; their existing tests keep passing and gain fixtures for `;`-delimited,
Latin-1, and multi-line-quoted files.

Header recognition by normalized synonyms (accent/case-insensitive), pt +
en + es: `telefone|celular|whatsapp|fone|phone` → phone, `nome|name` →
name, `empresa|company` → company, `e-mail|email`, `tags|etiquetas`,
`origem|fonte|source`, plus a **mapping step** for everything else.

Brazilian phone normalization (extending `phone-utils`): strip masks;
add DDI `55` when missing; accept the 8-digit legacy mobile form by
inserting the ninth digit only when unambiguous; classify landlines
(10-digit, leading 2–5 after DDD) as **`landline` → skipped with a
reason**, since WhatsApp rejects them and they cost sending reputation.

### 2. Server-side import with a real report

`POST /api/contacts/imports` (multipart; agent+; rate-limited; cap e.g.
5 MB / 5,000 rows for v1):

- Creates a `contact_imports` row, parses server-side, upserts contacts by
  normalized phone through the **same** dedupe/`findOrCreateContact` path
  the webhook and manual form use — one definition of "a contact exists".
- **Update policy** chosen in the wizard: `skip existing` | `fill empty
  fields` (default) | `overwrite`. **Never** clears `opted_out_at`; an
  opted-out phone is reported `skipped: opted_out` and stays opted out.
- **Per-row outcome, never all-or-nothing** (deskcomm's rule): a bad row
  is skipped with a nominal reason (`invalid_phone`, `landline`,
  `duplicate_in_file`, `opted_out`, `bad_email`) and the rest proceed.
- Extra columns map to **custom fields** (existing definitions; the
  wizard can create a missing one on the spot).
- Every imported contact gets tag `lista:<import name>` — so the existing
  tag audience in the Broadcast wizard and the Inbox tag filter work with
  **zero new audience plumbing**.
- Writes one `audit()` entry (`contacts.imported`, counts, import id) — the
  gesture is auditable, not just 5,000 silent inserts.

```sql
CREATE TABLE IF NOT EXISTS contact_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  file_name text,
  consent_basis text NOT NULL CHECK (consent_basis IN
    ('opt_in','existing_customer','legitimate_interest',
     'third_party_list','unknown')),
  legal_basis_ref text,   -- required when consent_basis = 'legitimate_interest'
  update_policy text NOT NULL DEFAULT 'fill_empty'
    CHECK (update_policy IN ('skip','fill_empty','overwrite')),
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','completed','failed')),
  rows_total int NOT NULL DEFAULT 0,
  rows_created int NOT NULL DEFAULT 0,
  rows_updated int NOT NULL DEFAULT 0,
  rows_skipped int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contact_import_errors (
  import_id uuid NOT NULL REFERENCES contact_imports(id) ON DELETE CASCADE,
  line int NOT NULL,
  reason text NOT NULL,        -- vocabulary code; UI translates it
  raw text,                    -- the offending cells (PII → RLS + retention)
  PRIMARY KEY (import_id, line)
);
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS import_id uuid
    REFERENCES contact_imports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consent_basis text
    CHECK (consent_basis IS NULL OR consent_basis IN
      ('opt_in','existing_customer','legitimate_interest','third_party_list','unknown'));
```

RLS: members `SELECT`; writes through the import route (service role).
`contact_import_errors.raw` is personal data: same account-scoped RLS, and
it is deleted with the import (`ON DELETE CASCADE`) — add an explicit
"delete this import's report" action and a retention note.

Phase 2 (durability for larger files): stage rows in a
`contact_import_rows` table and drain them from the existing automations
cron with a progress bar, exactly the broadcast-resume shape, so closing
the tab or a timeout can never leave a half-import.

### 3. The consent gate (the important part)

The wizard's first question is mandatory: **"Como você obteve estes
contatos?"**

| Answer | Stored basis | Effect |
|---|---|---|
| Pediram contato / deram opt-in | `opt_in` | Broadcast-eligible |
| Já são meus clientes | `existing_customer` | Broadcast-eligible, with a template-category reminder |
| Lead que captei por conta própria (formulário, anúncio, pesquisa pública) | `legitimate_interest` | **Prospecting campaign only** — requires a written `legal_basis_ref` (LGPD legitimate interest); not eligible for mass broadcasts |
| Lista de terceiros / comprada | `third_party_list` | **Imported for the CRM, blocked from broadcast *and* prospecting** |
| Não sei | `unknown` | Broadcast requires an explicit override + warning |

Rules, additive so nothing breaks for existing accounts:

- **`contacts.consent_basis IS NULL` (every existing contact) behaves
  exactly as today.** No retroactive restriction, no migration backfill.
- A contact's basis is only ever *upgraded* by a later import (e.g.
  `unknown → opt_in`), never silently downgraded.
- The Broadcast audience resolver excludes `third_party_list` contacts
  outright (with a count shown: "N contatos bloqueados — lista de
  terceiros") and requires an acknowledgement for `unknown`.
- On a **WAHA** channel the wizard adds the anti-ban reminder already
  shown in Settings (`Settings.waha.riskDescription`) and points at
  pacing.
- This is a **guardrail, not legal advice**. The copy states the
  responsibility stays with the account (LGPD lawful basis; Meta's
  opt-in requirement for business-initiated messages) and links the docs.

## Part B — the prospecting campaign

### 4. From list to outreach and through the funnel

The import result screen ends with **"Iniciar prospecção com esta lista"**
(and Contacts has the same entry for any `lista:` tag). Ordinary
one-message-to-many outreach stays the Broadcast wizard's job
(`scheduled-broadcasts.md`); a **prospecting campaign** is different: one
1:1 conversation per business, a personalised first message written by an
AI agent, sent slowly, and followed until the lead qualifies or goes cold.

**4.1 Campaign setup** (one wizard, validated server-side at activation):

| Field | Rule |
|---|---|
| Source | an import (`contact_imports`) — its eligible contacts become candidates |
| Agent | an active AI agent with auto-reply enabled; it writes the approach **and** answers the replies |
| Channel | a connected **WAHA** channel (Cloud API refused, with the reason shown) |
| Pipeline + entry stage + qualified stage | two different open stages of one pipeline |
| Instruction | what we offer, tone (10–2000 chars) |
| Qualification criteria | what the agent must confirm before the deal moves (10–2000 chars) |
| Daily limit | 1–50 (default 10) |
| Interval | minutes between sends (5–1440, default 15) |
| Legal basis ref | required text; copied to each contact |

Only **one campaign runs per account at a time** (partial unique index),
and a running campaign's config cannot be changed — pause, edit, resume.

**4.2 Activation — candidates.** For each contact of the import, in one
locked pass:

- skipped with a **nominal reason**: no valid mobile (`landline`,
  `invalid_phone`), `opted_out`, basis `third_party_list`, or **already in
  a conversation with history** ("contato já em atendimento — atendimento
  preservado", deskcomm's rule: cold outreach never hijacks a customer);
- otherwise: a **deal** in the entry stage (title = business name,
  description = campaign + qualification criteria), a **conversation**
  pinned to the campaign channel with the campaign's agent as the AI owner
  (so the reply is answered by the same agent — confirm the interaction
  with `multi-agent-router.md`: the router must not swap the agent
  mid-conversation), status `queued`.

```sql
CREATE TABLE IF NOT EXISTS prospecting_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  import_id uuid REFERENCES contact_imports(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','running','paused','completed','cancelled')),
  config jsonb NOT NULL,
  next_send_at timestamptz NOT NULL DEFAULT now(),
  error text,                       -- why it paused; the UI explains it
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_one_running_per_account
  ON prospecting_campaigns (account_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS prospecting_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id uuid REFERENCES deals(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','queued','sending','sent','failed','skipped')),
  error text,                       -- vocabulary code or short reason
  attempted_at timestamptz,         -- stamped BEFORE the send, never cleared
  sent_at timestamptz,
  replied_at timestamptz,
  qualified_at timestamptz,
  opted_out_at timestamptz,
  UNIQUE (campaign_id, contact_id)
);
```

The funnel is counted from the **stamps** (`sent_at`, `replied_at`,
`qualified_at`), never from `status`: `status` is one value, and counting by
it would make "sent" fall when the campaign goes *well* (a person who
replied is no longer "sent"). This is deskcomm's `metricas.ts` lesson.

**4.3 Sending — one candidate per tick, slowly.** Folded into the existing
automations cron (no new pinger); the cadence must be at most the shortest
allowed interval, so set the cron accordingly. Per tick, per account, in
order (any "not yet" just reschedules `next_send_at`):

1. campaign running; channel still connected (else **pause the campaign**);
2. inside the **sending window** (account timezone, e.g. 09–18 on weekdays;
   outside it, `next_send_at` = next opening);
3. the shared WAHA budget: reserve through `claim_waha_send_slot` *before*
   the effect (an uncertain send still consumes quota — a timeout must not
   release it);
4. daily cap: `min(campaign daily_limit, warm-up ceiling)` where the
   ceiling depends on the channel's age (a fresh number sending 20 cold
   first-touches on day one is the exact pattern that gets it banned; use
   deskcomm's stepped ceilings as the starting table) — counted over the
   last 24h across **all** cold sends of the account, not per campaign;
5. interval since the last attempt; the next send is scheduled with
   **jitter that only delays, never advances** (a fixed N-minute cadence is
   a robot signature, and the jitter must not break the minimum the
   operator set);
6. take the oldest `queued` candidate (claimed by flipping to `sending`
   with `attempted_at`, atomically); none left → campaign `completed`.

**4.4 The approach message.**

- Written by the campaign's agent (BYO key, usage logged) from the
  contact's name and the CSV's mapped fields (segment, city, company —
  whatever the account mapped), plus the campaign instruction.
- The cold-approach prompt is fixed by the product, not editable: short,
  transparent that the contact was found from public/own data, **never
  claims the person filled a form or showed interest, invents familiarity
  or results**, one question at a time, mentions the qualification
  criteria only as things to confirm during the conversation.
- The **opt-out line is appended by code, not requested from the model**,
  in the deployment's language ("Responda SAIR para não receber mais
  mensagens"). The existing STOP detection (`opt-out.ts`, sets
  `opted_out_at`) already recognises the isolated word; without the line
  the customer's only exit is "report spam", which is invisible to the
  system and burns the account's number.
- Sent through the same WAHA send path as agent replies (persisted as a
  normal outbound message with `ai_generated`, so it shows in the Inbox).
- **An uncertain send is never retried automatically** (timeout, no
  provider ack): the candidate becomes `failed` with "envio não
  confirmado — confira a conversa antes de reenviar", because a duplicate
  cold message is worse than a missing one.

**4.5 Failure scope decides whether the queue stops** (deskcomm's
`EscopoDaFalha`): errors are `candidate` (bad destination, the model
produced nothing for this business, the contact became opted-out between
activation and send) → mark that candidate `failed`/`skipped` and **keep
going**; or `campaign` (channel disconnected, agent unpublished, provider
key invalid, WAHA session down) → **pause the campaign** and store `error`
for the screen. Unclassified errors default to `campaign`: fail closed —
pausing a campaign that could have continued costs a resume click; not
pausing one that should have stopped costs the whole list.

**4.6 Replies and qualification.**

- A reply lands in the Inbox as a normal conversation and is answered by
  the same agent via the existing auto-reply path (cap, handoff and the
  `handoff-customer-notice.md` behaviour all apply).
- **Reply attribution**: on an inbound customer message, stamp
  `replied_at` on the candidate only if the message arrives within the
  attribution window after `sent_at` (default 72h, per-account setting) and
  the candidate isn't already stamped. If several campaigns reached the
  same contact, the **most recent** send wins. Outside the window it is an
  ordinary conversation, not a campaign reply — otherwise the reply rate
  would rise on its own as months pass. This runs inside the inbound
  webhook's fan-out, must never throw, and must be idempotent
  (`UPDATE … WHERE replied_at IS NULL`).
- **Qualification is a deal move.** New AI tool `move_deal_stage`
  (auto-reply only, like the agenda tools — a tool call is a real side
  effect): it can move **only this conversation's deal, only to the
  campaign's qualified stage**, and only once the agent has confirmed the
  criteria. Moving stamps `qualified_at`. The account sets the stage
  names; the agent never guesses another destination (deskcomm's
  `agent-stage-sync`: "sem mapeamento → o card fica onde está"). The
  human's own drag-and-drop in the pipeline also stamps it (a trigger on
  `deals.stage_id`), so a person can qualify a lead the AI didn't.
- **Opt-out closes the candidate**: when the contact opts out, pending
  candidates become `skipped: opted_out` and sent ones get `opted_out_at`
  (it is a metric for the ones already contacted).
- **Non-responders**: picked up by a follow-up sequence
  (`followup-sequences.md`) with a cold profile — at most two touches,
  spaced days apart, stopped by reply/opt-out/human takeover. Not built in
  this spec; the campaign stores what the sequence needs.

**4.7 The funnel screen** (per campaign): candidates → sent → replied →
qualified, plus failed/skipped/opted-out, each with its **declared
denominator** (reply rate = replied ÷ sent, qualification = qualified ÷
replied; excluded candidates never enter a denominator, so a dirty list
doesn't read as a bad offer). Each drop has a different cause and the copy
says so: falls between candidates and sent → the list (landlines,
duplicates, opted-out); between sent and replied → the message, the offer
or the audience; between replied and qualified → the qualification
criteria or the agent's prompt. Actions: pause / resume / cancel; a
per-candidate list with status and a link to the conversation.

**4.8 Audit.** One `audit()` entry per send *attempt* (successful or not),
never per empty tick, with pointers only (no phone, no generated text):
`prospecting.approach_sent { campaign_id, contact_id, conversation_id,
agent_id, channel_id, sent }`. This is the only flow that speaks first to
someone who never spoke to the business; when the person asks "why did you
message me?" the answer has to exist somewhere.

### 5. UI (import)

Contacts → Importar becomes a 4-step wizard (file → columns → basis &
policy → result) using the existing dialog/stepper components; a
"Baixar modelo" link serves a template CSV with the recognized headers; the
result shows counts plus a downloadable **error report CSV** (cells that
begin with `= + - @` are prefixed to defuse spreadsheet formula
injection). An "Importações" list (per import: date, who, counts, basis,
"ver contatos", "apagar relatório").

## Acceptance criteria

- [ ] A `;`-delimited, Latin-1, Excel-exported CSV with `Telefone`,
      `Nome`, `Empresa` and a quoted multi-line cell imports correctly
      (fixture-tested).
- [ ] A file with a bad row imports every other row and reports the bad
      one **by line and reason**; the report is downloadable.
- [ ] Re-importing the same file creates no duplicates and (default
      policy) fills only empty fields.
- [ ] An opted-out phone in the file stays opted out and is reported.
- [ ] Landline numbers are skipped with reason `landline`.
- [ ] Extra columns land in the mapped custom fields; unmapped columns
      are listed as ignored.
- [ ] A `third_party_list` contact never enters a broadcast audience; an
      existing contact (`consent_basis IS NULL`) still does.
- [ ] Closing the browser tab after upload does not change the outcome
      (import runs server-side).
- [ ] One `contacts.imported` audit row per import.
- [ ] `parseBroadcastCsv` and `parseContactCsv` share the parser and both
      handle `;`/Latin-1.
- [ ] `verify-schema.sql` asserts the new tables, columns and CHECKs; all
      four locales updated; the error report neutralizes formula cells.

Prospecting campaign (Part B):

- [ ] Activating a campaign on a Cloud API channel is refused with the
      reason; on WAHA it succeeds.
- [ ] Activation skips `third_party_list`, opted-out, landline, and
      contacts with an existing conversation history, each with a nominal
      reason; every other candidate gets a deal in the entry stage and a
      conversation owned by the campaign's agent.
- [ ] Only one campaign per account can be `running`; the DB rejects a
      second.
- [ ] Over the daily/warm-up cap, in the interval, or outside the window,
      a tick sends nothing and reschedules; an idle tick writes no audit
      row.
- [ ] Every approach ends with the opt-out line in the deployment's
      language, appended by code; a reply of that word opts the contact
      out and closes pending candidates.
- [ ] An uncertain send is marked `failed` and never retried on its own.
- [ ] A candidate-scoped error keeps the queue moving; a campaign-scoped
      or unclassified one pauses it with the reason shown.
- [ ] A customer reply inside the attribution window stamps `replied_at`
      exactly once; outside it, nothing; two campaigns → the most recent.
- [ ] `move_deal_stage` can only move the conversation's own deal, only to
      the campaign's qualified stage, and stamps `qualified_at`; moving by
      hand in the pipeline stamps it too.
- [ ] The funnel is computed from stamps, with excluded candidates out of
      the denominators (unit-tested like deskcomm's `metricas`).

## Risks / open questions

- **The number is the customer's asset.** Every cold first-touch lane is
  the one a platform punishes, and it is the *account's* number that is
  lost. That is why the limits (daily cap, warm-up ceiling, interval,
  window, opt-out line, one running campaign) are product rules, not
  settings the wizard lets you raise past a hard ceiling.
- **Confirm before building:** how `deals` link to contacts/conversations
  in this schema; that the multi-agent router keeps the campaign's agent on
  the conversation; the cron cadence available on the host versus the
  5-minute minimum interval; what `claim_waha_send_slot` budgets today
  (per channel per minute?) versus the daily ceilings above, which are a
  new counter.
- **`move_deal_stage` is the first AI tool that changes the sales
  pipeline.** Restricting it to one deal and one destination is the
  safety; a false "qualified" costs a human a wasted call, a missed one
  costs a lead — bias the prompt toward asking, and let the human correct
  (the screen shows who moved it).
- **Cold outreach is the account-killer.** Even with the gate, an
  `opt_in`-labelled list the user simply *claims* is opt-in cannot be
  verified. The gate makes the choice explicit and recorded; it does not
  make it true. Consider requiring a free-text "origem do opt-in" for
  `opt_in`.
- **Meta policy differs by channel.** On the Cloud API, first-touch
  business-initiated messages need an approved **template** and opt-in;
  on WAHA (unofficial) there is no policy enforcement — only ban risk.
  The wizard should say which applies to the channel the user will send
  from.
- **PII in `contact_import_errors.raw`.** Kept because a report is useless
  without the offending cells; scoped by RLS, deleted with the import.
  Alternative: store only the line number and reason (less useful,
  safer). Decide before implementing.
- **Import size.** 5,000 rows synchronously is a request-timeout risk on
  serverless hosts; phase 2 (staging + cron) is the real answer, and the
  cap should be set from measurement, not from this spec.
- **Ninth-digit heuristics** are wrong for some real numbers; on
  ambiguity, *reject with a reason* rather than guess (deskcomm's stance:
  "o que NÃO se aceita em silêncio é o ambíguo").
- **Optional WAHA number check.** WAHA exposes a "does this number have
  WhatsApp" lookup (confirm the exact endpoint/behavior at implementation
  time) — running it in the import would drop non-WhatsApp numbers before
  they hurt sending reputation. Not available on the Cloud API.
- **Tag-as-list is a shortcut.** It reuses audiences for free but tags are
  user-editable; if lists need to be immutable/auditable a first-class
  membership table is the alternative. Start with tags.

## Part A — implementation notes (v1)

Built: `src/lib/csv/parse.ts` (RFC 4180, `,`/`;`/tab detection, UTF-8 →
Windows-1252 fallback, pt/en/es header synonyms), `src/lib/contacts/br-phone.ts`
(masks, DDI 55, ninth digit on old 8-digit mobiles, landlines skipped),
`src/lib/contacts/import-plan.ts` (per-row plan, consent-basis upgrade-only,
update policies), `POST /api/contacts/imports` (server-side, per-line report,
`lista:<name>` tag, audit), migration 081, `ImportWizard` replacing the old
browser-side modal, and third-party-list contacts excluded from broadcasts.
Verified live: `;` file, landline / duplicate / bad e-mail reported by line,
re-import filling empty fields and upgrading the basis.

Not built yet:
- Custom-field mapping for extra columns (they are listed as "ignored").
- Existing-contact match is exact on the normalized phone; a contact stored
  without DDI or without the ninth digit is not matched (the unique index
  still refuses a true duplicate).
- The `unknown` acknowledgement in the Broadcast wizard; the blocked-count
  message ("N contatos bloqueados").
- The old `parse-contact-csv.ts` / broadcast CSV parser still exist
  (adapters over `lib/csv` not done); `import-modal.tsx` is no longer used.
- Imports list / re-open a past report; staged durable import (phase 2).
