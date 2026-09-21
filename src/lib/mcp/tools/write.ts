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
}


