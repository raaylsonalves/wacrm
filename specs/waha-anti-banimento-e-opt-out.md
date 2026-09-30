# Spec: anti-banimento no canal WAHA (throttle + opt-out no envio)

**Status: implemented.** Migration 064 (`claim_waha_send_slot`) + `lib/whatsapp/waha-throttle.ts`, claimed by both WAHA send paths (`send-message.ts`, `broadcast-core.ts`); manual send refuses `opted_out_at` contacts (`send-message.ts`, code `contact_opted_out`).

> Reescrita — a versão anterior desta spec propunha detecção de opt-out
> como se não existisse. Ela já existe (migration 053,
> `src/lib/contacts/opt-out.ts`, wireada no webhook WAHA, nas
> automações e no broadcast). Esta versão corta essa parte e foca só
> no que de fato falta: throttle de envio e a checagem de opt-out no
> caminho que ainda não olha pra ela — o envio manual.

## Problem

O canal WAHA (`src/lib/whatsapp/waha-api.ts`) manda mensagem sem
throttle nenhum — `sendWahaText` chama `/api/sendText` direto, sem
espaçamento mínimo entre chamadas, seja de um agente respondendo rápido
no inbox, de uma automação, ou de um broadcast disparando em loop. WAHA
é integração NÃO OFICIAL do WhatsApp; um padrão de envio que parece
rajada é o motivo mais comum de banimento sem aviso prévio nem recurso
fácil — quem paga o preço é o número do cliente final.

Separadamente, a detecção de opt-out (`isOptOutMessage`,
`contacts.opted_out_at`) já bloqueia automações
(`src/lib/automations/engine.ts`) e broadcast
(`src/hooks/use-broadcast-sending.ts`), mas **não** o envio manual —
`sendMessageToConversation` (`src/lib/whatsapp/send-message.ts`) manda
pelo WAHA sem checar `opted_out_at`. Um agente humano ainda consegue
mandar mensagem pra um contato que já pediu pra parar.

## Non-goals

- Não cobre o canal oficial (Meta Cloud API) — passa pela infra e pelas
  regras de rate limit da própria Meta, o risco é outro.
- Não reimplementa detecção de opt-out — isso já existe e está fora de
  escopo aqui. Only a leitura de `contacts.opted_out_at` no envio
  manual está em escopo.
- Não é fila/worker externo. O throttle é resolvido no banco (ver
  Proposed change) — nada de Redis/Upstash nesta primeira versão,
  mesmo rodando em serverless (Vercel).
- Não cobre throttle por contato (ex.: "no máximo 1 msg/contato/dia") —
  é só espaçamento entre chamadas HTTP da mesma sessão WAHA.

## Current behavior

- `sendWahaText(baseUrl, apiKey, sessionName, chatId, text)`
  (`src/lib/whatsapp/waha-api.ts:168`) — uma chamada HTTP, sem estado,
  sem espaçamento. Chamada por três caminhos: envio manual
  (`send-message.ts`), automações (`src/lib/automations/*`), e
  broadcast (`use-broadcast-sending.ts` → API route de broadcast).
- `whatsapp_waha_channels` (migration 056) não tem nenhuma coluna de
  "última vez que mandou mensagem" — não há como saber, hoje, quando
  foi o envio anterior nessa sessão.
- O runtime é serverless (Vercel) — cada request pode cair num processo
  Node diferente. Um contador em memória (o padrão que
  `src/lib/rate-limit.ts` já usa para outra coisa, com esse trade-off
  documentado no próprio arquivo) não coordena entre invocações
  concorrentes da mesma sessão WAHA — duas respostas simultâneas de
  agentes diferentes, ou uma automação + um broadcast ao mesmo tempo,
  furariam a fila. Precisa ser uma claim atômica no banco, no mesmo
  espírito de `claim_ai_reply_slot` (migration 029/031).
- `send-message.ts`'s branch WAHA (`if (conversation.whatsapp_channel_id)`)
  não lê `contacts.opted_out_at` antes de chamar `sendWahaText`.

## Proposed change

### 1. Throttle via claim atômico no banco (migration 064)

```sql
ALTER TABLE whatsapp_waha_channels
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_waha_send_slot(
  channel_id uuid,
  min_interval_ms integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE whatsapp_waha_channels
    SET last_sent_at = now()
    WHERE id = channel_id
      AND (last_sent_at IS NULL
           OR last_sent_at <= now() - (min_interval_ms || ' ms')::interval)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.claim_waha_send_slot(uuid, integer) TO service_role;
```

Igual ao padrão de `claim_ai_reply_slot`: um `UPDATE ... WHERE ...
RETURNING` atômico é a claim — duas chamadas concorrentes não podem
ambas passar, porque a segunda não vê mais a condição `last_sent_at <=
...` depois que a primeira já atualizou a linha. Funciona corretamente
sob concorrência serverless sem Redis.

- Caminho 1-a-1 (resposta manual, IA, automação): `min_interval_ms =
  1200`, mais jitter aleatório de até 800ms ANTES de tentar a claim
  (não depois) — o jitter existe pra não parecer programado, não só
  pra respeitar o intervalo.
- Caminho de broadcast: `min_interval_ms = 5000`.
- Se a claim falhar (`false`), o chamador espera
  `min_interval_ms - tempo já decorrido` (ou um valor fixo pequeno, ex.
  300ms) e tenta de novo — nunca desiste silenciosamente a mensagem.
- Sessão nova (< 14 dias desde `connected_at`): usar o dobro do
  intervalo normal nesse período de warm-up — checagem simples,
  `now() - connected_at < interval '14 days'`, sem coluna nova.

Todo chamador de `sendWahaText` passa a chamar `claim_waha_send_slot`
antes — o ponto de entrada único já é `sendWahaText`, então dá pra
encapsular a claim ali dentro (recebendo o `channel.id` como parâmetro
novo) em vez de espalhar a chamada pelos três callers.

### 2. Checagem de opt-out no envio manual

Em `send-message.ts`, no branch WAHA, antes de chamar `sendWahaText`:
ler `contacts.opted_out_at` do `contact` já carregado nessa função (se
ainda não estiver no objeto, um select extra por `id`) e, se não for
null, lançar `SendMessageError('contact_opted_out', 'Este contato
pediu para não receber mensagens.', 409)` — mesmo padrão de erro
tipado que os outros branches já usam.

A UI (`MessageComposer`/`MessageThread`) precisa tratar esse código
mostrando a mensagem ao agente, não um erro genérico — o mesmo texto
que já existe no badge de contato anonimizado/LGPD é uma referência de
tom.

## Acceptance criteria

- [ ] Migration 064 cria `whatsapp_waha_channels.last_sent_at` e a
      função `claim_waha_send_slot`
- [ ] `supabase/ci/verify-schema.sql` ganha assertion para os dois
- [ ] Duas chamadas concorrentes de `claim_waha_send_slot` para o mesmo
      canal com `min_interval_ms=1200` — só uma retorna `true` dentro
      da janela (teste de integração/SQL direto, não só unitário)
- [ ] Envio manual, de automação e de broadcast chamam a claim antes de
      `sendWahaText`, com os intervalos corretos por caminho (1200 /
      1200 / 5000)
- [ ] Canal com menos de 14 dias desde `connected_at` usa o intervalo
      dobrado
- [ ] Enviar manualmente para um contato com `opted_out_at` preenchido
      é recusado com `contact_opted_out` ANTES de chamar `sendWahaText`
- [ ] A UI mostra ao agente por que a mensagem não saiu (não um erro
      genérico) quando o envio é recusado por opt-out

## Risks / open questions

- `claim_waha_send_slot` serializa por CANAL, não por conta — se uma
  conta tem duas conversas simultâneas no mesmo número WAHA, a segunda
  espera a primeira. Isso é o comportamento correto (é a mesma sessão
  WhatsApp fazendo os dois envios), mas pode surpreender um agente que
  não entenda por que a resposta "demorou" ~1.2s — vale um indicador
  visual discreto de "enviando" em vez de travar a UI sem feedback.
- Espera ativa (`sleep`+retry) dentro de uma rota serverless consome
  tempo de execução faturável — para o caso de broadcast (potencialmente
  centenas de claims em sequência), reavaliar se o loop de disparo
  deveria rodar fora do request/response (ex.: via
  `automation_pending_executions`/cron, que o wacrm já tem para outra
  coisa) em vez de dentro de uma única invocação HTTP.
