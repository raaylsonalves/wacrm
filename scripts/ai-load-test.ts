/**
 * AI cost load test — a scripted "customer robot" talks to a real agent
 * through the same path the auto-reply uses (knowledge retrieval +
 * auto_reply system prompt + the account's provider), and measures the
 * tokens each reply really costs. Feeds specs/pricing-costs.md.
 *
 * Read-only on the database and sends nothing on WhatsApp: it only reads
 * the account's agent config and knowledge base, then calls the provider.
 *
 *   npx tsx --env-file=.env.local scripts/ai-load-test.ts <account_id> [runs]
 */
import { createClient } from '@supabase/supabase-js';
import { loadAiConfig } from '@/lib/ai/config';
import { retrieveKnowledge } from '@/lib/ai/knowledge';
import { generateReply } from '@/lib/ai/generate';
import { aiContextMessageLimit, buildSystemPrompt } from '@/lib/ai/defaults';
import { latestUserMessage } from '@/lib/ai/query';
import type { ChatMessage } from '@/lib/ai/types';

interface Scenario {
  id: string;
  /** null = use the agent's own prompt and knowledge base. */
  prompt: string | null;
  turns: string[];
}

const business = (who: string, rules: string) =>
  `Você é a assistente virtual de ${who}. Atende pelo WhatsApp com mensagens curtas, cordiais e objetivas, em português do Brasil, sem emojis em excesso.

Objetivo: entender o que a pessoa precisa, responder dúvidas com as informações abaixo e, quando fizer sentido, levar para o próximo passo (agendar, enviar orçamento ou passar para a equipe). Nunca invente preços, horários ou condições que não estejam aqui; se não souber, diga que vai confirmar com a equipe.

Informações do negócio:
${rules}

Regras gerais:
- Uma pergunta por vez. Confirme dados importantes antes de seguir.
- Se o cliente pedir para falar com uma pessoa, reclamar ou o assunto fugir do que está aqui, passe para a equipe.
- Peça o nome do cliente no início se ainda não souber.
- Não prometa prazos de retorno exatos.`;

const SCENARIOS: Scenario[] = [
  {
    id: 'agente-real',
    prompt: null,
    turns: [
      'Oi, boa tarde',
      'Queria saber como funciona o sistema de vocês',
      'Serve pra uma clínica pequena? Somos 3 pessoas',
      'E quanto custa?',
      'A IA responde sozinha mesmo? E se o cliente mandar áudio?',
      'Dá pra usar o número que eu já tenho?',
      'Tem fidelidade?',
      'Legal, como faço pra testar?',
    ],
  },
  {
    id: 'autonomo',
    prompt: business(
      'Studio Bela Unha (manicure e pedicure, atendimento com hora marcada)',
      `- Endereço: Rua das Flores, 120, sala 3, Fortaleza.
- Horário: terça a sábado, 9h às 19h.
- Serviços e preços: mão R$ 35; pé R$ 40; pé e mão R$ 70; esmaltação em gel R$ 90; manutenção de gel R$ 70; spa dos pés R$ 60.
- Pagamento: Pix, cartão ou dinheiro.
- Atrasos acima de 15 minutos precisam ser remarcados.
- Para agendar: pegue nome, serviço, dia e período preferido; a equipe confirma o horário.`
    ),
    turns: [
      'Oi! Vocês fazem gel?',
      'Quanto fica?',
      'E manutenção?',
      'Tem horário sábado de manhã?',
      'Meu nome é Carla, quero gel no sábado de manhã',
      'Aceita pix?',
      'Ok, obrigada!',
    ],
  },
  {
    id: 'loja',
    prompt: business(
      'Mercadinho Bom Preço (delivery de bairro)',
      `- Entregas: segunda a sábado, 8h às 20h; domingo 8h às 13h.
- Taxa de entrega: R$ 5 até 3 km; grátis acima de R$ 100.
- Pedido mínimo: R$ 30.
- Pagamento na entrega: Pix, cartão ou dinheiro (levar troco: avisar o valor).
- Itens em promoção esta semana: arroz 5 kg R$ 24,90; feijão 1 kg R$ 7,49; óleo R$ 6,99; café 500 g R$ 15,90.
- Não temos lista de todos os produtos aqui; para itens fora da lista, a equipe confirma.`
    ),
    turns: [
      'Bom dia, vocês entregam no Jardim América?',
      'Qual a taxa?',
      'Quanto tá o arroz?',
      'Quero 2 arroz, 1 feijão e 1 café',
      'Pago no cartão na entrega',
      'Rua Ceará 45',
    ],
  },
  {
    id: 'clinica',
    prompt: business(
      'Clínica Sorriso Leve (odontologia)',
      `- Endereço: Av. Santos Dumont, 2000, sala 804.
- Horário: segunda a sexta, 8h às 18h; sábado 8h às 12h.
- Avaliação inicial: R$ 80, abatida do tratamento se fechado no mesmo dia.
- Limpeza: R$ 180. Clareamento a laser: a partir de R$ 900. Restauração: a partir de R$ 200.
- Convênios aceitos: Amil Dental, OdontoPrev e Bradesco Dental.
- Urgência (dor forte, dente quebrado): encaixe no mesmo dia, passar para a equipe.
- Para agendar: nome completo, convênio ou particular, motivo, melhor dia e período.`
    ),
    turns: [
      'Olá, vocês atendem OdontoPrev?',
      'Quero fazer uma limpeza',
      'Quanto custa se for particular?',
      'E clareamento?',
      'Dói muito o clareamento?',
      'Vou fazer pelo convênio a limpeza. Tem quinta à tarde?',
      'Ana Paula Ribeiro',
      'Isso, quinta depois das 14h',
      'Obrigada',
    ],
  },
  {
    id: 'imobiliaria',
    prompt: business(
      'Lar Ideal Imóveis (venda e aluguel)',
      `- Atuamos em Fortaleza e Eusébio.
- Qualificação antes de indicar imóveis: compra ou aluguel; bairro ou região; quartos; faixa de valor; financiamento (FGTS, aprovado ou não); prazo para mudar.
- Aluguel: exigimos fiador, seguro-fiança ou título de capitalização.
- Financiamento: trabalhamos com Caixa e Itaú; o corretor faz a simulação.
- Visitas: segunda a sábado, com corretor; marcar com 1 dia de antecedência.
- Não envie endereço exato do imóvel antes da visita marcada.`
    ),
    turns: [
      'Boa tarde, vi um anúncio de apartamento de vocês',
      'Quero comprar',
      'Na Aldeota ou Meireles',
      '3 quartos de preferência',
      'Até uns 700 mil',
      'Vou financiar, tenho FGTS',
      'Ainda não fiz simulação',
      'Queria mudar até o meio do ano que vem',
      'Dá pra visitar no sábado?',
      'Pode ser de manhã. Meu nome é Ricardo',
    ],
  },
  {
    id: 'credito',
    prompt: business(
      'Agius Crédito (correspondente bancário: consignado INSS e servidores)',
      `- Produtos: empréstimo consignado INSS, cartão consignado, portabilidade e refinanciamento.
- Para simular precisamos de: nome, CPF, se é aposentado/pensionista do INSS ou servidor, e o valor do benefício aproximado.
- Não pedimos senha nem código por mensagem, nunca.
- Taxas seguem o teto do INSS; o valor exato só sai na simulação feita pela equipe.
- Documentos para contratar: RG ou CNH, comprovante de residência e extrato do benefício.
- Atendimento humano: segunda a sexta, 8h às 18h.`
    ),
    turns: [
      'Oi quero fazer um empréstimo',
      'Sou aposentada do INSS',
      'Quanto consigo pegar?',
      'Meu benefício é uns 2 mil',
      'Já tenho um empréstimo no banco, dá pra fazer portabilidade?',
      'Qual a taxa?',
      'Maria de Fátima, CPF 123.456.789-00',
      'Precisa de que documento?',
      'Vocês ligam pra mim?',
    ],
  },
];

async function main() {
  const accountId = process.argv[2];
  const runs = Number(process.argv[3] ?? 1);
  if (!accountId) throw new Error('usage: ai-load-test.ts <account_id> [runs]');
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const base = await loadAiConfig(db, accountId, { requireActive: false });
  if (!base) throw new Error('account has no default agent');
  console.error(`provider ${base.provider} / ${base.model}`);

  const rows: Record<string, unknown>[] = [];
  for (const s of SCENARIOS) {
    for (let run = 0; run < runs; run++) {
      const config =
        s.prompt === null ? base : { ...base, systemPrompt: s.prompt };
      const history: ChatMessage[] = [];
      let tin = 0,
        tout = 0,
        cached = 0,
        calls = 0,
        handoff = false;
      for (const turn of s.turns) {
        history.push({ role: 'user', content: turn });
        const messages = history.slice(-aiContextMessageLimit());
        const knowledge =
          s.prompt === null
            ? await retrieveKnowledge(
                db,
                accountId,
                config,
                latestUserMessage(messages)
              )
            : [];
        const systemPrompt = buildSystemPrompt({
          userPrompt: config.systemPrompt,
          mode: 'auto_reply',
          knowledge,
        });
        const res = await generateReply({ config, systemPrompt, messages });
        calls++;
        tin += res.usage?.promptTokens ?? 0;
        tout += res.usage?.completionTokens ?? 0;
        cached += res.usage?.cachedTokens ?? 0;
        history.push({ role: 'assistant', content: res.text || '(sem texto)' });
        if (res.handoff) {
          handoff = true;
          break;
        }
      }
      rows.push({
        scenario: s.id,
        run,
        calls,
        handoff,
        tokens_in: tin,
        tokens_out: tout,
        cached,
        avg_in: Math.round(tin / calls),
        avg_out: Math.round(tout / calls),
      });
      console.error(
        `${s.id} #${run}: ${calls} replies, ${tin} in / ${tout} out${handoff ? ' (handoff)' : ''}`
      );
    }
  }
  console.log(JSON.stringify(rows));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
