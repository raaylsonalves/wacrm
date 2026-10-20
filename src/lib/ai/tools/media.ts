import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolDefinition, ToolExecutor } from '../types';
import { engineSendMedia } from '@/lib/flows/meta-send';

// ============================================================
// send_image: pictures an agent may send (migration 140), chosen by the
// model from the conversation — a price table when the customer asks
// for prices, not whenever a message contains "valor". Each picture
// goes at most once per MEDIA_DEDUPE_MS in a conversation.
// ============================================================

import { MEDIA_DEDUPE_MS, type MediaItem } from '../media-library';

export {
  MEDIA_DEDUPE_MS,
  MEDIA_LIBRARY_MAX,
  parseMediaLibrary,
  type MediaItem,
} from '../media-library';

export function mediaTools(items: MediaItem[]): ToolDefinition[] {
  if (items.length === 0) return [];
  return [
    {
      name: 'send_image',
      description:
        'Sends ONE of the business pictures to the customer on WhatsApp. Call it only when the customer\'s LATEST message itself asks for what a picture is for (see each picture\'s "when" in the prompt) — never because of earlier messages, never while booking, confirming or chatting, and never two pictures in one reply: pick the single best match. A special variant (e.g. VIP) only when the customer named it. After it is sent, answer in text with what they asked (e.g. the price of the service they mentioned), without describing the picture.',
      parameters: {
        type: 'object',
        properties: {
          image_id: { type: 'string', enum: items.map((i) => i.id) },
        },
        required: ['image_id'],
      },
    },
  ];
}

export function mediaPromptSection(items: MediaItem[]): string | null {
  if (items.length === 0) return null;
  return (
    'Pictures you can send with send_image (at most once per conversation each):\n' +
    items
      .map(
        (i) =>
          `- ${i.id} — ${i.name}: ${i.when || 'when it helps the customer'}`
      )
      .join('\n')
  );
}

/** Pure: was this picture sent in the conversation recently? */
export function recentlySent(
  sent: { media_url: string | null; created_at: string }[],
  url: string,
  now: number
): boolean {
  return sent.some(
    (m) =>
      m.media_url === url &&
      now - new Date(m.created_at).getTime() < MEDIA_DEDUPE_MS
  );
}

export function createMediaToolExecutor(ctx: {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  contactId: string;
  userId: string;
  agentId?: string | null;
  items: MediaItem[];
}): ToolExecutor {
  // One picture per reply: the model sometimes asked for two tables at
  // once ("corte e barba" → normal + VIP), seen in scripts/ai-media-eval.ts.
  let sentThisReply = false;
  return async (name, args) => {
    if (name !== 'send_image')
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    if (sentThisReply) {
      return JSON.stringify({
        error: 'one picture per reply: answer in text now',
      });
    }
    const item = ctx.items.find((i) => i.id === args.image_id);
    if (!item) return JSON.stringify({ error: 'unknown image_id' });
    const { data: sent } = await ctx.db
      .from('messages')
      .select('media_url, created_at')
      .eq('conversation_id', ctx.conversationId)
      .eq('media_url', item.url)
      .order('created_at', { ascending: false })
      .limit(1);
    const rows = (sent ?? []) as {
      media_url: string | null;
      created_at: string;
    }[];
    if (recentlySent(rows, item.url, Date.now())) {
      return JSON.stringify({
        already_sent: true,
        note: 'The customer already has this picture: do not send it again.',
      });
    }
    try {
      sentThisReply = true;
      await engineSendMedia({
        accountId: ctx.accountId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        kind: 'image',
        link: item.url,
        aiGenerated: true,
        aiAgentId: ctx.agentId ?? null,
      });
      return JSON.stringify({
        sent: true,
        note: 'Picture delivered. Now answer briefly in text; do not describe it.',
      });
    } catch (err) {
      sentThisReply = false;
      console.error('[ai media tool] send failed:', err);
      return JSON.stringify({
        error: 'could not send the picture; answer in text',
      });
    }
  };
}
