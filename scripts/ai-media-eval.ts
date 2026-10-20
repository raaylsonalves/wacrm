/**
 * Does an agent send its pictures (send_image, migration 140) at the right
 * moments? Runs scripted conversations against the REAL model with the
 * agent's real prompt and library, but a fake tool executor: nothing is
 * sent to WhatsApp. Costs a few cents of the account's own AI key.
 *
 *   npx tsx --env-file=.env.local --tsconfig tsconfig.json \
 *     scripts/ai-media-eval.ts <account_id> <agent_id> [cases.json]
 *
 * cases.json: [{ "say": ["msg", ...], "expect": "image_id" | null }]
 * (several messages = a conversation; the last one is judged). Without it,
 * the barbershop cases below run.
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { loadAiConfig } from '@/lib/ai/config';
import { buildSystemPrompt } from '@/lib/ai/defaults';
import { generateReplyWithFallback } from '@/lib/ai/generate-with-fallback';
import { mediaPromptSection, mediaTools } from '@/lib/ai/tools/media';
import type { ChatMessage } from '@/lib/ai/types';

interface Case {
  say: string[];
  expect: string | null;
}

const DEFAULT_CASES: Case[] = [
  { say: ['quanto custa o corte?'], expect: 'tabela' },
  { say: ['qual o valor da barba?'], expect: 'tabela' },
  { say: ['me manda a tabela de preços'], expect: 'tabela' },
  { say: ['quanto fica corte e barba?'], expect: 'tabela' },
  { say: ['qual o valor da área vip?'], expect: 'vip' },
  { say: ['quanto custa o corte vip?'], expect: 'vip' },
  { say: ['tem horário amanhã de manhã?'], expect: null },
  { say: ['quero valorizar meu rosto, o que vocês indicam?'], expect: null },
  { say: ['o valor que paguei semana passada veio errado'], expect: null },
  { say: ['quanto custa pra remarcar?'], expect: null },
  { say: ['quanto tempo demora o corte?'], expect: null },
  { say: ['obrigado, valeu!'], expect: null },
  { say: ['vocês aceitam pix?'], expect: null },
  {
    say: ['oi', 'quero marcar um corte', 'pode ser às 10h com o Ítalo'],
    expect: null,
  },
];

async function main() {
  const [accountId, agentId, casesPath] = process.argv.slice(2);
  if (!accountId || !agentId)
    throw new Error(
      'usage: ai-media-eval.ts <account_id> <agent_id> [cases.json]'
    );
  const cases: Case[] = casesPath
    ? JSON.parse(readFileSync(casesPath, 'utf8'))
    : DEFAULT_CASES;
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const config = await loadAiConfig(db, accountId, {
    agentId,
    requireActive: false,
  });
  if (!config) throw new Error('agent not found');
  const items = config.mediaLibrary ?? [];
  if (items.length === 0) throw new Error('this agent has no pictures');

  // The same prompt shape as auto-reply, minus agenda/booking context.
  const systemPrompt = [
    buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge: [],
    }),
    mediaPromptSection(items),
  ].join('\n\n');

  let pass = 0;
  for (const c of cases) {
    const messages: ChatMessage[] = [];
    let sent: string | null = null;
    let reply = '';
    let calls = 0;
    for (const [i, text] of c.say.entries()) {
      messages.push({ role: 'user', content: text });
      const last = i === c.say.length - 1;
      const result = await generateReplyWithFallback({
        config: { ...config, fallbacks: [] },
        systemPrompt,
        messages,
        tools: mediaTools(items),
        executeTool: async (name, args) => {
          if (name !== 'send_image')
            return JSON.stringify({ error: 'not available in this test' });
          if (!last)
            return JSON.stringify({ error: 'not available in this test' });
          calls++;
          if (calls > 1)
            return JSON.stringify({
              error: 'one picture per reply: answer in text now',
            });
          sent = String(args.image_id);
          return JSON.stringify({
            sent: true,
            note: 'Picture delivered. Now answer briefly in text; do not describe it.',
          });
        },
      });
      reply = result.text ?? '';
      messages.push({ role: 'assistant', content: reply });
    }
    // Earlier turns of a scripted conversation are setup, not judged.
    const ok = sent === c.expect;
    if (ok) pass++;
    console.log(
      `${ok ? 'ok  ' : 'ERRO'} | imagem: ${(sent ?? '-').padEnd(6)} (esperado ${c.expect ?? '-'}) | ${c.say.at(-1)}`
    );
    console.log(`       ↳ ${reply.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  console.log(`\n${pass}/${cases.length} como esperado`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
