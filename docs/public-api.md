# Public API (`/api/v1`)

The public API lets you drive your wacrm instance from your own
scripts and automations — send messages, manage contacts, launch
broadcasts — without going through the dashboard UI.

> **Status:** stable. Authentication, scopes, rate limiting, the
> messages / contacts / conversations / broadcasts endpoints, and
> outbound event [webhooks](#webhooks) all ship now.

## Authentication

Every request authenticates with an **API key**, sent as a bearer
token:

```
Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are **account-scoped**: a key acts on exactly one account, the
one it was created in. There is no cross-account access.

### Creating a key

In the dashboard: **Settings → API keys → New API key**. Only
**admins and owners** can create keys.

1. Give the key a name (after the integration that will use it).
2. Grant the **scopes** it needs — nothing more (see below).
3. Copy the key. **The full key is shown exactly once.** wacrm
   stores only a SHA-256 hash, so it can never be shown again. If you
   lose it, revoke it and create a new one.

### Revoking a key

**Settings → API keys → Revoke.** Revocation is effective on the
key's next request. Revoked keys stay in the list as an audit trail.

## Scopes

A key can do only what its scopes allow — independent of who created
it. Grant the minimum.

| Scope                | Allows                                   |
| -------------------- | ---------------------------------------- |
| `messages:send`      | Send WhatsApp messages                   |
| `messages:read`      | Read messages and delivery status        |
| `contacts:read`      | List and read contacts                   |
| `contacts:write`     | Create and update contacts               |
| `conversations:read` | List and read conversations              |
| `broadcasts:send`    | Launch broadcast campaigns               |
| `webhooks:manage`    | Register and manage outbound webhooks    |
| `automations:read`   | List automations and their templates     |
| `automations:write`  | Create and update automations            |
| `flows:read`         | List flows and their templates           |
| `flows:write`        | Create and update flows (from a template)|

A key with **no scopes** still authenticates and can call
`GET /api/v1/me` — useful for verifying a key works.

## Response envelope

Every response uses one of two shapes:

```jsonc
// success
{ "data": { /* ... */ } }

// failure
{ "error": { "code": "forbidden", "message": "This API key is missing the 'messages:send' scope" } }
```

Branch on `error.code` (stable); `error.message` is for humans and
may be reworded.

| Status | `code`         | Meaning                                          |
| ------ | -------------- | ------------------------------------------------ |
| 401    | `unauthorized` | Missing / malformed / unknown / revoked / expired key |
| 403    | `forbidden`    | Valid key, but missing the required scope        |
| 429    | `rate_limited` | Per-key rate limit exceeded                      |
| 400    | `bad_request`  | Malformed input                                  |
| 404    | `not_found`    | No such resource                                 |
| 500    | `internal`     | Server error                                     |

## Rate limits

Requests are limited **per key**: **120 requests per minute**. On a
`429`, these headers tell you when to retry:

- `Retry-After` — seconds until the window resets
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

> The limiter is in-memory and **per process**. A single-instance
> deploy (the common case for a self-hosted fork) is fine as-is. If
> you scale to multiple instances, swap the limiter for a shared
> store (Redis/Upstash) — see the note at the top of
> `src/lib/rate-limit.ts`. The limit is otherwise unenforced across
> instances.

## Endpoints

### `GET /api/v1/me`

Returns the account a key is bound to and the scopes it carries.
Requires only a valid key (no scope). Use it to verify a key works
and to discover its scopes.

```bash
curl https://your-crm.example.com/api/v1/me \
  -H "Authorization: Bearer wacrm_live_xxx"
```

```json
{
  "data": {
    "account": { "id": "…", "name": "Acme Inc" },
    "key": { "id": "…", "scopes": ["messages:send"] }
  }
}
```

### `POST /api/v1/messages`

Send a WhatsApp message to a phone number. Scope: `messages:send`. You
pass an **E.164 number**, not an internal id — the endpoint
finds-or-creates the contact + conversation, then sends.

```bash
curl -X POST https://your-crm.example.com/api/v1/messages \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "+14155550123", "type": "text", "text": "Hi 👋" }'
```

`type` is `text` (default), `template`, or a media kind (`image` /
`video` / `document` / `audio`). Media needs `media_url` (and optional
`filename`); `text` doubles as the caption. `template` needs a
`template` object:

```jsonc
{
  "to": "+14155550123",
  "type": "template",
  "template": {
    "name": "order_update",
    "language": "en_US",
    "params": ["A123"]        // positional body vars, or a structured object
  },
  "reply_to_message_id": "<uuid>"   // optional; must be in the same conversation
}
```

Response (201):

```json
{
  "data": {
    "message_id": "…",
    "whatsapp_message_id": "wamid.…",
    "conversation_id": "…",
    "contact_id": "…",
    "contact_created": true
  }
}
```

Domain error codes beyond the table above: `whatsapp_not_configured`
(400), `meta_error` (502 — the request reached Meta and it rejected the
send), `template_malformed` (500).

### `GET /api/v1/contacts`

List contacts, newest first. Scope: `contacts:read`. Paginated (see
[Pagination](#pagination)). Optional filters: `?search=` (matches name
or phone) and `?tag=<tagId>`.

```json
{
  "data": [
    {
      "id": "…", "phone": "+14155550123", "name": "Jane Doe",
      "email": null, "company": "Acme", "avatar_url": null,
      "tags": [{ "id": "…", "name": "vip", "color": "#3b82f6" }],
      "created_at": "…", "updated_at": "…"
    }
  ],
  "meta": { "next_cursor": "…" }
}
```

### `POST /api/v1/contacts`

Create a contact. Scope: `contacts:write`. `phone` (E.164) is required;
`name`, `email`, `company`, and `tags` (an array of tag names, created
if missing) are optional. **Find-or-create by phone:** an existing
match returns `200` with the existing contact; a new contact returns
`201`. The response body is the serialized contact (same shape as the
list rows above).

### `GET` / `PATCH /api/v1/contacts/{id}`

Read or update one contact. Scopes: `contacts:read` / `contacts:write`.
`PATCH` updates only the fields you send (`name`, `email`, `company`);
pass `tags` (an array of tag names) to replace the contact's tags. A
contact in another account returns `404`.

### `GET /api/v1/conversations`

List conversations, newest first. Scope: `conversations:read`.
Paginated. Optional filters: `?status=` (`open` / `pending` / `closed`)
and `?contact_id=`. Each conversation embeds its contact + tags.

### `GET /api/v1/conversations/{id}`

Read one conversation. Scope: `conversations:read`. `404` if it belongs
to another account.

### `GET /api/v1/conversations/{id}/messages`

List a conversation's messages, newest first. Scope: `messages:read`.
Paginated. Each message includes its `direction` (`inbound` /
`outbound`), `status` (delivery state), `whatsapp_message_id`, and
`content_*`. The conversation is verified to belong to your account
first (`404` otherwise).

### `POST /api/v1/broadcasts`

Launch a template broadcast to a list of recipients. Scope:
`broadcasts:send`. The broadcast + its recipient rows are persisted
immediately and the sends fan out in the background, so the call
returns fast — poll `GET /api/v1/broadcasts/{id}` for progress.

```bash
curl -X POST https://your-crm.example.com/api/v1/broadcasts \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "July promo",
        "template_name": "promo_july",
        "template_language": "en_US",
        "recipients": [
          { "to": "+14155550123", "params": ["Jane"] },
          { "to": "+14155550124" }
        ]
      }'
```

Recipients are capped at **1000 per request** — split larger sends.
Invalid phone numbers are dropped and counted as `rejected`. Response
(202):

```json
{
  "data": {
    "broadcast_id": "…",
    "status": "sending",
    "total_recipients": 2,
    "accepted": 2,
    "rejected": 0
  }
}
```

### `GET /api/v1/broadcasts/{id}`

Broadcast status + counts. Scope: `broadcasts:send`. `status` moves
`sending` → `sent`; `delivered_count` / `read_count` keep climbing as
Meta delivery webhooks arrive. `404` for another account's broadcast.

### `GET /api/v1/automations`

List the account's automations, newest first. Scope: `automations:read`.
Not paginated (accounts rarely have more than a handful).

### `GET /api/v1/automations/templates`

List the quick-start automation templates available to clone (welcome
message, out-of-office, lead qualifier, follow-up reminder). Scope:
`automations:read`. Each item is `{ slug, name, description,
trigger_type }` — pass `slug` as `template` to `POST /api/v1/automations`.

### `POST /api/v1/automations`

Create an automation. Scope: `automations:write`.

```bash
# Clone a template
curl -X POST https://your-crm.example.com/api/v1/automations \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "template": "out_of_office" }'

# Or build a custom one
curl -X POST https://your-crm.example.com/api/v1/automations \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Tag VIP leads",
        "trigger_type": "keyword_match",
        "trigger_config": { "keywords": ["vip"], "match": "contains" },
        "steps": [
          { "step_type": "add_tag", "step_config": { "tag_name": "VIP" } }
        ]
      }'
```

Pass either `template` (a slug from the templates endpoint — `steps`
is ignored when a valid one is given) or `trigger_type` + `steps` built
from scratch; `trigger_config`'s shape depends on `trigger_type` and
mirrors what the dashboard's automation builder sends (see
`src/lib/automations/validate.ts` for the exact fields each trigger and
step type expects). Created as a draft (`is_active: false`) unless you
pass `is_active: true`, in which case the same validation the dashboard
enforces before publishing runs first — an incomplete trigger/step
configuration is rejected with `400 bad_request` rather than silently
saved broken.

### `PATCH /api/v1/automations/:id`

Update an automation's `name`, `description`, `trigger_type`,
`trigger_config`, or `is_active`. Scope: `automations:write`. Narrower
than the dashboard's own edit route — `steps` can't be changed here;
edit the step list in the dashboard builder. Activating, or editing an
already-active automation, re-runs the same validation `POST` does and
is rejected with `422` if the result would be invalid.

```bash
curl -X PATCH https://your-crm.example.com/api/v1/automations/<id> \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "is_active": true }'
```

### `GET /api/v1/flows`

List the account's flows, newest first. Scope: `flows:read`. Not
paginated.

### `GET /api/v1/flows/templates`

List the quick-start flow templates available to clone (welcome menu,
FAQ bot, lead capture). Scope: `flows:read`. Each item is `{ slug,
name, description, trigger_type }` — pass `slug` as `template_slug` to
`POST /api/v1/flows`.

### `POST /api/v1/flows`

Create a flow. Scope: `flows:write`.

```bash
curl -X POST https://your-crm.example.com/api/v1/flows \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "template_slug": "welcome_menu" }'
```

Pass `template_slug` (recommended — clones the template's full node
graph as an immediately-activatable draft) or just `name` (and
optionally `trigger_type`) for an empty draft with no nodes yet.
Building a custom node graph isn't supported on **create** — flows are
a stateful per-contact conversation graph (see `CLAUDE.md`'s
"Automations vs Flows" section) — but `PATCH /api/v1/flows/:id` below
can set the full node graph on an existing flow.

### `PATCH /api/v1/flows/:id`

Update a flow's `name`, entry trigger (`trigger_type`/`trigger_config`),
`entry_node_id`, and/or its full conversation node graph (`nodes`).
Scope: `flows:write`.

```bash
curl -X PATCH https://your-crm.example.com/api/v1/flows/<id> \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "entry_node_id": "start",
        "nodes": [
          { "node_key": "start", "node_type": "start",
            "config": { "next_node_key": "menu" } },
          { "node_key": "menu", "node_type": "send_buttons",
            "config": { "text": "Escolha uma opção:", "buttons": [
              { "reply_id": "a", "title": "Opção A", "next_node_key": "end" },
              { "reply_id": "b", "title": "Opção B", "next_node_key": "end" }
            ] } },
          { "node_key": "end", "node_type": "end", "config": {} }
        ]
      }'
```

`nodes`, when passed, **replaces the entire graph** (delete-then-insert
— send the complete set, not a diff you want merged). Unlike the
dashboard builder, there's no live UI catching mistakes as you go, so
the graph is always validated as a whole before saving — entry node
exists, every `next_node_key` resolves, no unreachable nodes, WhatsApp
interactive limits (`send_buttons` ≤3 buttons/≤20-char titles,
`send_list` ≤10 rows) — and the call is rejected with `422` and the
specific issues if the result would be invalid. This applies
regardless of the flow's `status`, not just to already-active flows.

Node types and their `config` shape (`node_key` is a stable id you
choose, referenced by other nodes' `next_node_key`):

| `node_type` | `config` |
| --- | --- |
| `start` | `{ next_node_key }` |
| `send_message` | `{ text, next_node_key }` |
| `send_media` | `{ media_type: "image"\|"video"\|"document", media_url, caption?, next_node_key }` |
| `send_buttons` | `{ text, buttons: [{ reply_id, title, next_node_key }] }` (1–3 buttons) |
| `send_list` | `{ text, button_label, sections: [{ title?, rows: [{ reply_id, title, description?, next_node_key }] }] }` |
| `collect_input` | `{ prompt_text, var_key, next_node_key }` — waits for the customer's next text reply, stores it under `var_key` |
| `condition` | `{ subject: "var"\|"tag"\|"contact_field", subject_key, operator: "equals"\|"contains"\|"present"\|"absent", value?, true_next, false_next }` |
| `set_tag` | `{ mode: "add"\|"remove", tag_id, next_node_key }` |
| `handoff` / `end` | `{}` — terminal, no outgoing edge |

## Pagination

Every list endpoint pages the same way. Request a page size with
`?limit=` (default 50, max 100) and read the next page with the opaque
`meta.next_cursor` from the previous response:

```
GET /api/v1/contacts?limit=50
→ { "data": [ … ], "meta": { "next_cursor": "eyJ…" } }

GET /api/v1/contacts?limit=50&cursor=eyJ…
→ { "data": [ … ], "meta": { "next_cursor": null } }   // last page
```

Cursors are keyset-based (stable under concurrent inserts). Pass the
cursor back verbatim — don't parse it. `next_cursor: null` means the
last page.

## Webhooks

Rather than polling, register an endpoint and wacrm will POST to it when
things happen in your account. **Migration required:** apply
`supabase/migrations/028_webhook_endpoints.sql`.

### Events

| Event                    | Fires when                                        |
| ------------------------ | ------------------------------------------------- |
| `message.received`       | An inbound message arrives from a contact         |
| `message.status_updated` | A message you sent changed delivery status        |
| `conversation.created`   | A new conversation is opened for a contact        |

### Managing endpoints

All under scope `webhooks:manage`.

- `POST /api/v1/webhooks` — register `{ "url": "https://…", "events": ["message.received"] }`. `url` must be `https://`. **The response includes `secret` exactly once** — store it to verify signatures; wacrm keeps only an encrypted copy.
- `GET /api/v1/webhooks` — list your endpoints (never returns the secret).
- `GET /api/v1/webhooks/{id}` — read one.
- `PATCH /api/v1/webhooks/{id}` — update `url`, `events`, or `is_active` (re-enabling clears the failure counter).
- `DELETE /api/v1/webhooks/{id}` — remove one.

```bash
curl -X POST https://your-crm.example.com/api/v1/webhooks \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hooks/wacrm", "events": ["message.received"] }'
# → 201 { "data": { "id": "…", "url": "…", "events": [...], "secret": "whsec_…" } }
```

### Delivery payload

Every delivery is a POST with this envelope; `id` is a unique per-
delivery uuid you can dedupe on, and `data` varies by `event`:

```json
{
  "id": "8f3c…",
  "event": "message.received",
  "occurred_at": "2026-07-01T12:00:00.000Z",
  "account_id": "…",
  "data": { /* per-event, see below */ }
}
```

`data` by event:

```jsonc
// message.received
{ "conversation_id": "…", "contact_id": "…", "whatsapp_message_id": "wamid.…", "content_type": "text", "text": "Hi 👋" }
// conversation.created
{ "conversation_id": "…", "contact_id": "…" }
// message.status_updated
{ "whatsapp_message_id": "wamid.…", "conversation_id": "…", "status": "delivered" }
```

Headers: `X-Wacrm-Event`, `X-Wacrm-Webhook-Id`, and `X-Wacrm-Signature`.

### Verifying the signature

`X-Wacrm-Signature: t=<unix_seconds>,v1=<hex>` where `v1 =
HMAC-SHA256(secret, "${t}.${rawBody}")`. Recompute it over the **raw
request body** and compare in constant time; reject if `t` is more than
a few minutes old (replay protection).

```js
const [, t, v1] = header.match(/t=(\d+),v1=([0-9a-f]+)/);
const expected = crypto.createHmac('sha256', secret)
  .update(`${t}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

### Delivery semantics

Delivery is **best-effort**: a single attempt per event with a short
timeout, and **redirects are not followed**. `message.status_updated`
covers messages wacrm stores (inbox + API sends), not broadcast-only
sends, and — because providers re-send and re-order status callbacks —
the same status may arrive more than once or out of order; **dedupe on
`id` and don't assume ordering**. Each consecutive failure increments
`failure_count`; after enough consecutive failures the endpoint is
auto-disabled (`is_active: false`) — re-enable it with `PATCH` (which
resets the counter). Durable retry-with-backoff (a delivery queue) is a
future enhancement; today, treat missed deliveries as possible and
reconcile with the read endpoints when it matters.

**Target restrictions (SSRF).** The `url` must be `https://` and must
resolve to a public address — requests to `localhost`, private/RFC1918
ranges, link-local (incl. cloud metadata `169.254.169.254`), and similar
internal targets are refused at delivery time.

## Roadmap

The public API now covers messaging, contacts, conversations,
broadcasts, automations, flows, and outbound webhooks — the full scope
of [#245](https://github.com/ArnasDon/wacrm/issues/245) plus the
automations/flows creation endpoints added afterward. Future ideas
(deals/pipelines, WhatsApp templates, a custom flow-node-graph
endpoint, a delivery queue for webhooks) are not yet scheduled.
