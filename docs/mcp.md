# MCP server

wacrm ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so you can drive your CRM from AI assistants — Claude Desktop,
Claude Code, Cursor, and any other MCP client — in natural language:

> "How many conversations are still open today?"
> "Show the last five messages with +1 415 555 0123."
> "Send the `order_update` template to that contact."

It lives in [`mcp-server/`](../mcp-server) and is published to npm as
[`wacrm-mcp`](https://www.npmjs.com/package/wacrm-mcp). Under the hood
it's a thin wrapper over the [public API](./public-api.md), so every
request is authenticated and scoped by your instance exactly like any
other API call.

## Quick start

1. Create an API key in the dashboard: **Settings → API keys**. Grant
   only the scopes your assistant needs (a read-only assistant only
   needs the `*:read` scopes).
2. Add the server to your MCP client config:

   ```jsonc
   {
     "mcpServers": {
       "wacrm": {
         "command": "npx",
         "args": ["-y", "wacrm-mcp"],
         "env": {
           "WACRM_BASE_URL": "https://crm.example.com",
           "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
         }
       }
     }
   }
   ```

That's **read-only** — the safe default. To let the assistant change
data or send messages, add `"WACRM_ENABLE_WRITES": "true"` (and
`"WACRM_ENABLE_BROADCASTS": "true"` for mass sends) to `env`.

## What it exposes

- **Reads (always on):** `whoami`, contacts (list/get), conversations
  (list/get), messages (list), broadcast status, automations (list),
  automation templates (list), flows (list), flow templates (list).
- **Writes (opt-in):** send a message, create/update a contact, create
  an automation, create a flow.
- **Broadcasts (opt-in):** launch a template broadcast — requires an
  explicit `confirm` and is marked destructive.

### Creating automations and flows

`create_automation` and `create_flow` are the two tools for building
"no-code automation" from natural language:

> "Create an automation from the out-of-office template."
> "Make a flow that greets new contacts with a menu, cloned from the
> welcome_menu template."

Cloning a quick-start template (`list_automation_templates` /
`list_flow_templates` first, to see the available slugs) is the
recommended path — it produces something immediately usable. A custom
automation can also be built step-by-step via `trigger_type` /
`trigger_config` / `steps`; a custom flow node graph isn't supported
over the API yet — build one from a template, then refine it further
in the dashboard's flow builder. Both tools require the matching
`automations:write` / `flows:write` scope on top of
`WACRM_ENABLE_WRITES`, and create in a draft/inactive state unless
`is_active: true` is explicitly passed.

## Safety

Because sending WhatsApp messages is a real side effect, the server is
**read-only until you opt in**, layered on top of the API key's own
scopes. Give an assistant a read-only key and read-only config and it
physically cannot send anything. See the
[server README](../mcp-server/README.md) for the full tool list and
safety model.
