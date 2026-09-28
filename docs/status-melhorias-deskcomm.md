# Status: melhorias inspiradas no DeskcommCRM + conexão WAHA

> Documento de rastreio, não uma spec. Objetivo único: qualquer sessão
> futura (esta ou outra) consegue abrir este arquivo e saber, sem
> reconstruir contexto, o que já foi feito e o que ainda é só uma spec
> escrita. Atualize esta lista sempre que uma spec referenciada aqui
> for implementada ou uma nova for aberta.
>
> PRD-mãe: [`prd-melhorias-inspiradas-no-deskcomm.md`](prd-melhorias-inspiradas-no-deskcomm.md).
> Última revisão: 2026-09-28 (throttle WAHA implementado).

## Concluído

### Conexão WAHA (multi-número WhatsApp)
- Schema (`whatsapp_waha_channels`, `conversations.whatsapp_channel_id`
  — migration 056), cliente HTTP (`src/lib/whatsapp/waha-api.ts`),
  webhook de entrada com HMAC (`src/app/api/whatsapp/webhook/waha/route.ts`),
  envio de saída plugado em `sendMessageToConversation`.
- QR code E pareamento por código (`/auth/request-code`) na tela de
  conexão (`src/components/settings/waha-channels.tsx`).
- Reaproveita a instância WAHA já conectada a partir do 2º canal; com
  `WAHA_API_BASE_URL`/`WAHA_API_KEY` no ambiente, pula o formulário
  desde o 1º canal (paridade com o modelo de instância única do
  deskcomm).
- Fix: sessão precisa de `/start` explícito depois de criada (WAHA não
  auto-inicia) — sem isso o QR nunca saía do estado `STOPPED`.
- Fixes subsequentes de estabilidade do QR (ver `git log --oneline --
  src/lib/whatsapp/waha-api.ts` para o histórico completo — vários
  ajustes depois do primeiro fix, então trate qualquer resumo aqui como
  o estado no momento desta revisão, não a lista definitiva).
- Filtro por canal + badge (Inbox: lista de conversas e cabeçalho da
  thread), visível só quando a conta tem algum canal WAHA.
- Spec original: [`waha-channel-connection.md`](../specs/waha-channel-connection.md).

### LGPD, opt-out, kanban (rodada anterior à conexão WAHA)
- Opt-out detection: `contacts.opted_out_at` (migration 053),
  `isOptOutMessage()` em `src/lib/contacts/opt-out.ts` — regra de
  palavra isolada OU verbo+objeto (evita falso positivo tipo "tem como
  parar a dor?"). Bloqueia automações, broadcast, e o envio manual (ver
  abaixo).
- Anonimização LGPD: `contacts.anonymized_at` (migration 054),
  `POST /api/contacts/[id]/anonymize`, capability `canManageLgpd`.
- Reordenação de card no Kanban por fractional indexing:
  `deals.position_in_stage` (migration 055), `@dnd-kit/sortable`.

### Anti-banimento WAHA — throttle de envio + opt-out no envio manual
- Migration 064: `whatsapp_waha_channels.last_sent_at` +
  `claim_waha_send_slot(channel_id, min_interval_ms)` — claim atômico
  no banco (`UPDATE...WHERE...RETURNING`, mesmo padrão de
  `claim_ai_reply_slot`), coordena corretamente entre invocações
  serverless concorrentes sem precisar de Redis.
- `src/lib/whatsapp/waha-throttle.ts` (`claimWahaSendSlot`): jitter
  antes da claim, retry com espera até 10s, intervalo dobrado se o
  canal tem menos de 14 dias desde `connected_at`, e nunca manda sem
  throttle — se a claim não vier em 10s, lança `WahaThrottleError` em
  vez de seguir pro envio.
- Wireado no único chamador real de `sendWahaText` hoje
  (`send-message.ts`, envio manual/API pública) — automações e
  broadcast ainda não mandam via WAHA (seguem Cloud-API-only), então
  não têm o que throttle proteger ainda; herdam a proteção
  automaticamente no dia em que passarem a chamar `sendWahaText`.
- `send-message.ts` agora também recusa enviar (código
  `contact_opted_out`, 409) pra um contato com `opted_out_at`
  preenchido, fechando o único caminho que faltava.
- Testado: `src/lib/whatsapp/waha-throttle.test.ts` (6 casos — slot
  imediato, warm-up, broadcast, retry até sucesso, timeout por claim
  perdida, timeout por erro na RPC).
- Spec: [`waha-anti-banimento-e-opt-out.md`](../specs/waha-anti-banimento-e-opt-out.md).

### Agenda / agendamentos (feita em sessão paralela — confirmada só por `git log`, não implementada nesta conversa)
- Schema de appointments (migrations 058–059, 061), tool-calling de
  agenda pra IA (migration 060), reagendamento e checagem de
  double-booking.
- Commits: `7952265`, `c2f93ca`, `a25b32c`, `e952e5a`, `4aa68b0`.
- Specs: [`agenda-appointments.md`](../specs/agenda-appointments.md),
  [`ai-agenda-tool-calling.md`](../specs/ai-agenda-tool-calling.md).
- A nota exploratória original
  ([`agenda-exploratory.md`](../specs/agenda-exploratory.md)) tinha
  concluído que não havia equivalente no deskcomm — isso segue
  correto; a feature foi construída greenfield no wacrm.

### Outros (confirmados só por `git log`, fora do escopo desta conversa)
- OpenRouter como provider de IA (migration 062).
- Busca lexical FTS com OR em vez de AND na base de conhecimento
  (migration 063).
- Vários fixes de confiabilidade do auto-reply de IA (timeout do
  fallback chain, logging, thoughtSignature do Gemini).
- "Limpar histórico da conversa" no menu de contexto do Inbox.

## Pendente — specs escritas, aguardando implementação

| Spec | Prioridade (PRD) | O que falta |
|---|---|---|
| [`audit-log-endurecido.md`](../specs/audit-log-endurecido.md) | P0 | Tudo — tabela `audit_log` não existe. |
| [`multi-agent-router.md`](../specs/multi-agent-router.md) | — | Tudo — `ai_configs` continua único por conta, sem roteador. |
| [`grouped-navigation.md`](../specs/grouped-navigation.md) | — | Tudo — menu lateral continua a lista plana atual. |
| [`signup-onboarding-wizard.md`](../specs/signup-onboarding-wizard.md) | — | Tudo — sem wizard, sem `accounts.onboarding_state`. |

## Decisão de produto pendente (nem é spec ainda — precisa validar com dados reais antes)

- **P1 — Distribuição self-host** (instalador Docker): só vale a pena
  se houver pedido real de cliente.
- **P2 — White-label por conta**: só vale a pena se o wacrm for
  vendido por agências/revendas.
- **P2 — Extensões declarativas**: só vale a pena se aparecer padrão
  recorrente de customização de nicho pedida por clientes.

Ver `prd-melhorias-inspiradas-no-deskcomm.md` para o racional completo
de cada um.

## Fora do radar deste documento

O diretório `specs/` tem outras specs (SLA de resposta, i18n, menu de
contexto do inbox, billing, provider Gemini, etc.) que pertencem a
outras frentes de trabalho, não à comparação com o deskcomm — não
foram auditadas aqui. Se for rastrear o backlog completo do produto,
esse é um documento separado.
