// ============================================================
// Write tools — registered only when WACRM_ENABLE_WRITES is set.
//
// These change data or send a WhatsApp message. They are gated so a
// read-only deployment never exposes them to the model at all. (The
// API key's scopes are still enforced server-side; a call without the
// right scope returns a clean `forbidden` error.)
// ============================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import type { WacrmClient } from '../client';
import { handle, jsonResult } from './shared';

const templateSchema = z
  .object({
    name: z.string().describe('Meta-approved template name.'),
    language: z.string().describe('Template language code, e.g. "en_US".'),
    params: z
      .array(z.string())
      .optional()
      .describe('Positional body variables, in order.'),
  })
  .describe('Template payload — required when type is "template".');

export function registerWriteTools(server: McpServer, client: WacrmClient): void {
  server.registerTool(
    'send_message',
    {
      title: 'Send WhatsApp message',
      description:
        'Send a WhatsApp message to a phone number (E.164, e.g. +14155550123). The contact and conversation are found-or-created automatically. Use type "text" for a free-form message (only valid inside the 24-hour customer-service window), or "template" to send an approved template (required to open a new conversation). Media types (image/video/document/audio) require a media_url. This sends a real message to a real person — confirm the recipient and content with the user before calling.',
      inputSchema: {
        to: z.string().describe('Recipient phone number in E.164 format, e.g. +14155550123.'),
        type: z
          .enum(['text', 'template', 'image', 'video', 'document', 'audio'])
          .default('text')
          .describe('Message type. Defaults to "text".'),
        text: z
          .string()
          .optional()
          .describe('Message body for "text", or the caption for a media type.'),
        media_url: z
          .string()
          .url()
          .optional()
          .describe('Publicly reachable URL of the media file (required for media types).'),
        filename: z.string().optional().describe('File name for a "document" send.'),
        template: templateSchema.optional(),
        reply_to_message_id: z
          .string()
          .optional()
          .describe('Optional id of a message in the same conversation to reply to.'),
      },
      annotations: { title: 'Send WhatsApp message', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.sendMessage(args))),
  );

  server.registerTool(
    'create_contact',
    {
      title: 'Create contact',
      description:
        'Create a contact by phone number (E.164, required). Find-or-create: if a contact with that phone already exists it is returned unchanged. Optional: name, email, company, and tags (tag names, created if missing).',
      inputSchema: {
        phone: z.string().describe('Phone number in E.164 format, e.g. +14155550123.'),
        name: z.string().optional(),
        email: z.string().email().optional(),
        company: z.string().optional(),
        tags: z.array(z.string()).optional().describe('Tag names; created if they do not exist.'),
      },
      annotations: { title: 'Create contact', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.createContact(args))),
  );

  server.registerTool(
    'update_contact',
    {
      title: 'Update contact',
      description:
        'Update an existing contact. Only the fields you pass are changed. Pass tags (an array of tag names) to replace the contact’s tags entirely.',
      inputSchema: {
        id: z.string().describe('Contact id.'),
        name: z.string().optional(),
        email: z.string().email().optional(),
        company: z.string().optional(),
        tags: z.array(z.string()).optional().describe('Replaces the contact’s tags.'),
      },
      annotations: { title: 'Update contact', readOnlyHint: false, openWorldHint: true },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updateContact(id, body))),
  );

  server.registerTool(
    'create_automation',
    {
      title: 'Create automation',
      description:
        'Create an automation (trigger → linear step list with conditional branches). Two ways to build one: pass `template` (a slug from list_automation_templates) to clone a ready-made one, or pass `trigger_type`/`trigger_config`/`steps` to build a custom one — check list_automation_templates first if you are not building something bespoke, it produces something immediately usable. Created as inactive (a draft) unless `is_active: true` is passed; activating with an invalid trigger/step configuration is rejected with the same validation the dashboard builder applies.',
      inputSchema: {
        template: z
          .string()
          .optional()
          .describe('Slug of a template from list_automation_templates to clone.'),
        name: z.string().optional().describe('Required unless cloning a template.'),
        description: z.string().optional(),
        trigger_type: z
          .enum([
            'new_message_received',
            'first_inbound_message',
            'keyword_match',
            'new_contact_created',
            'conversation_assigned',
            'tag_added',
            'time_based',
            'interactive_reply',
          ])
          .optional()
          .describe('Required unless cloning a template.'),
        trigger_config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Shape depends on trigger_type — see docs/public-api.md.'),
        steps: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            'Linear step list (send_message, wait, condition, assign_conversation, create_deal, add_tag, handoff, …) — see docs/public-api.md for each step_type\'s config shape.',
          ),
        is_active: z.boolean().optional().describe('Publish immediately instead of saving as a draft.'),
      },
      annotations: { title: 'Create automation', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.createAutomation(args))),
  );

  server.registerTool(
    'update_automation',
    {
      title: 'Update automation',
      description:
        'Update an existing automation\'s name, description, trigger, or active state. Does not touch its step list — edit steps in the dashboard builder. Activating (`is_active: true`) or editing an already-active automation is rejected if the resulting trigger/steps would be invalid, same validation as the dashboard builder. Requires the automation id from list_automations.',
      inputSchema: {
        id: z.string().describe('Automation id.'),
        name: z.string().optional(),
        description: z.string().optional(),
        trigger_type: z
          .enum([
            'new_message_received',
            'first_inbound_message',
            'keyword_match',
            'new_contact_created',
            'conversation_assigned',
            'tag_added',
            'time_based',
            'interactive_reply',
          ])
          .optional(),
        trigger_config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Shape depends on trigger_type — see docs/public-api.md.'),
        is_active: z.boolean().optional().describe('Activate or deactivate the automation.'),
      },
      annotations: { title: 'Update automation', readOnlyHint: false, openWorldHint: false },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updateAutomation(id, body))),
  );

  server.registerTool(
    'create_flow',
    {
      title: 'Create flow',
      description:
        'Create a flow (a stateful per-contact WhatsApp conversation graph — menus, FAQ bots, lead capture). Pass `template_slug` (from list_flow_templates) to clone a ready-made one — the recommended way, since a fully custom node graph isn\'t supported over this API yet. Without a template, only an empty draft (`name` + optional `trigger_type`) is created; add its conversation logic in the dashboard\'s flow builder afterward.',
      inputSchema: {
        template_slug: z
          .string()
          .optional()
          .describe('Slug of a template from list_flow_templates to clone.'),
        name: z.string().optional().describe('Required unless cloning a template.'),
        trigger_type: z
          .enum(['keyword', 'first_inbound_message', 'manual'])
          .optional()
          .describe('Only used for the empty-draft path; templates carry their own trigger.'),
      },
      annotations: { title: 'Create flow', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.createFlow(args))),
  );

  server.registerTool(
    'update_flow',
    {
      title: 'Update flow',
      description:
        'Update an existing flow\'s name, entry trigger, and/or its conversation node graph. Use trigger_type "keyword" with trigger_config.keywords to make an active flow start when a customer sends one of those phrases. Requires the flow id from list_flows.\n\n' +
        'IMPORTANT about `nodes`: when passed, it REPLACES the flow\'s entire node graph (delete-then-insert), not a partial patch — always send the complete set of nodes you want the flow to end up with. There is no visual builder here to catch mistakes as you go, so the graph is validated as a whole before saving (entry node exists, every next_node_key resolves, no unreachable nodes, WhatsApp interactive limits) and the call is rejected with the specific issues if it would be invalid — fix and resend rather than iterating node-by-node. Each node needs a unique `node_key` (a stable string you choose, referenced by other nodes\' `next_node_key`) and a `node_type` — see docs/public-api.md for the full catalog and each one\'s `config` shape:\n' +
        '- "start" — config: { next_node_key }\n' +
        '- "send_message" — config: { text, next_node_key }\n' +
        '- "send_media" — config: { media_type: "image"|"video"|"document", media_url, caption?, next_node_key }\n' +
        '- "send_buttons" — config: { text, buttons: [{ reply_id, title, next_node_key }] } (1–3 buttons, title ≤20 chars, each button branches independently)\n' +
        '- "send_list" — config: { text, button_label, sections: [{ title?, rows: [{ reply_id, title, description?, next_node_key }] }] } (≤10 rows total)\n' +
        '- "collect_input" — config: { prompt_text, var_key, next_node_key } (waits for the customer\'s next text reply, stores it under var_key)\n' +
        '- "condition" — config: { subject: "var"|"tag"|"contact_field", subject_key, operator: "equals"|"contains"|"present"|"absent", value?, true_next, false_next }\n' +
        '- "set_tag" — config: { mode: "add"|"remove", tag_id, next_node_key }\n' +
        '- "offer_slots" — config: { text, button_label, appointment_title?, duration_minutes?, days_ahead?, max_options? (≤10), assigned_to?, reschedule? (default false — when true, moves the contact\'s soonest upcoming appointment to the tapped time instead of creating a new one; appointment_title is ignored in this mode), next_node_key, no_slots_next_node_key (also used when reschedule is true and the contact has nothing upcoming) } (lists free agenda slots and books/reschedules the tapped one; the time lands in {{vars.agendamento}})\n' +
        '- "handoff" / "end" — terminal nodes, config: {} (no outgoing edge)',
      inputSchema: {
        id: z.string().describe('Flow id.'),
        name: z.string().optional(),
        trigger_type: z.enum(['keyword', 'first_inbound_message', 'manual']).optional(),
        trigger_config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('For keyword triggers, use {"keywords":["simular empréstimo"],"match_type":"contains"}.'),
        entry_node_id: z
          .string()
          .optional()
          .describe('node_key of the node where the conversation starts. Required for the graph to validate once nodes are set.'),
        nodes: z
          .array(
            z.object({
              node_key: z.string().describe('Stable, unique id for this node, referenced by other nodes\' next_node_key.'),
              node_type: z.string().describe('e.g. send_message, send_buttons, send_list, question, condition, assign_conversation, add_tag, handoff.'),
              config: z
                .record(z.string(), z.unknown())
                .describe('Shape depends on node_type — see docs/public-api.md.'),
              position_x: z.number().optional().describe('Builder canvas X position (cosmetic only). Defaults to 0.'),
              position_y: z.number().optional().describe('Builder canvas Y position (cosmetic only). Defaults to 0.'),
            }),
          )
          .optional()
          .describe('REPLACES the entire node graph when passed — send the complete set, not a diff.'),
      },
      annotations: { title: 'Update flow', readOnlyHint: false, openWorldHint: false },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updateFlow(id, body))),
  );
}

