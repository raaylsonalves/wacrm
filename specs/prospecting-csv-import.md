# Spec: Prospecting lists from a CSV (server-side import, consent-aware)

> deskcomm's prospecting depends on an external data API to fetch leads.
> The user wants the same outcome without that dependency: **import a
> spreadsheet of prospects we collected ourselves**, enrich them with the
> extra columns, and start outreach from that list. The import half is a
> port of deskcomm's `POST /api/v1/leads/import` + `lib/leads/planilha.ts`
> + `lib/contacts/csv.ts`; the outreach half reuses what wacrm already has
> (broadcasts, WAHA throttle/rotation) plus `specs/scheduled-broadcasts.md`
> and `specs/followup-sequences.md`. The **consent gate** in this spec is
> new and is the part that keeps the number alive.

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

- **Data providers, scraping, or enrichment APIs.** The explicit point is
  to replace the deskcomm API dependency with a file the user supplies.
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
    ('opt_in','existing_customer','third_party_list','unknown')),
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
      ('opt_in','existing_customer','third_party_list','unknown'));
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
| Lista de terceiros / comprada | `third_party_list` | **Imported for the CRM, blocked from broadcast/outreach** |
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

### 4. From list to outreach

The import result screen ends with **"Iniciar campanha com esta lista"**:
opens the Broadcast wizard with audience = the `lista:<name>` tag, the
consent filter already applied, and (once shipped) the schedule picker
from `scheduled-broadcasts.md`. Replies arrive in the Inbox as normal
conversations; non-responders can be picked up by a follow-up sequence
(`followup-sequences.md`) — not built into this spec.

### 5. UI

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

## Risks / open questions

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
