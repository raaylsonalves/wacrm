# Status: melhorias inspiradas no DeskcommCRM + conexão WAHA

> Documento de rastreio, não uma spec. Objetivo único: qualquer sessão
> futura (esta ou outra) consegue abrir este arquivo e saber, sem
> reconstruir contexto, o que já foi feito e o que ainda é só uma spec
> escrita. Atualize esta lista sempre que uma spec referenciada aqui
> for implementada ou uma nova for aberta.
>
> PRD-mãe: [`prd-melhorias-inspiradas-no-deskcomm.md`](prd-melhorias-inspiradas-no-deskcomm.md).
> Última revisão: 2026-09-28 (navegação agrupada implementada).

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

### Log de auditoria endurecido
- Migration 065: tabela `audit_log` (índice `(account_id, created_at
  desc)`), RLS de leitura por membro da conta, e o endurecimento real —
  `REVOKE UPDATE, DELETE, TRUNCATE` de `anon`, `authenticated` E
  `service_role` — nem uma chave de serviço vazada apaga o rastro.
- Helper `audit()` em `src/lib/audit.ts`: fire-and-forget, nunca lança
  (erro só vai pro console), nunca aceita segredo/corpo de mensagem no
  `metadata`.
- Instrumentado nos 4 pontos de alto risco da spec: criar/excluir
  canal WAHA (`src/app/api/whatsapp/waha/channels/route.ts` e
  `[id]/route.ts`), mudar papel de membro
  (`src/app/api/account/members/[userId]/route.ts`, grava
  `old_role`/`new_role`), disparar broadcast
  (`src/lib/whatsapp/broadcast-core.ts`'s `createBroadcast` — 1 linha
  por disparo, não por destinatário, sem corpo/params do template), e
  anonimizar contato (`src/app/api/contacts/[id]/anonymize/route.ts`).
- **Gap conhecido**: a rota legada de envio imediato de broadcast
  (`src/app/api/whatsapp/broadcast/route.ts`, o fluxo antigo do
  dashboard que não passa por `createBroadcast`) não está
  instrumentada ainda — só o caminho moderno (`/api/v1/broadcasts`)
  está.
- Testado: `src/lib/audit.test.ts` (4 casos).
- Spec: [`audit-log-endurecido.md`](../specs/audit-log-endurecido.md).

### Múltiplos agentes de IA + roteador de intenção
- Migration 066: `ai_configs` perde o `UNIQUE(account_id)`, ganha
  `name`/`is_default` (backfill automático — a conta com 1 agente
  continua exatamente igual); `ai_routers`/`ai_router_members` novas;
  `conversations.active_ai_agent_id` para o sticky routing.
- `src/lib/ai/config.ts`: `loadAiConfig` ganha `agentId?` opcional (sem
  ele, resolve o agente `is_default` — comportamento idêntico ao de
  antes para quem não usa multi-agente); `listAiAgents()` novo.
  `/api/ai/config` (o editor do agente padrão, inalterado na UI) e
  `/api/ai/test` foram ajustados por baixo dos panos para escopar
  todas as queries por `is_default`/`id`, já que um `UPDATE`/`DELETE`
  só por `account_id` passaria a afetar TODOS os agentes da conta.
- `src/lib/ai/router.ts`: `loadActiveRouterForChannel` (canal
  específico vence o roteador de conta inteira) e
  `resolveAgentViaRouter` — sticky, classificação via prompt curto
  contra a própria chave BYO da conta (nunca um serviço de
  classificação separado), fallback pro `fallback_agent_id` ou pro
  agente padrão, e falha do classificador nunca derruba o turno
  (sempre cai no agente padrão já carregado).
- Wireado em `dispatchInboundToAiReply` (`src/lib/ai/auto-reply.ts`) —
  a resolução roda antes do corte por limite de respostas, então o
  cap/handoff/claim atômico já operam sobre o agente resolvido, não
  sobre um fixo. Inerte pra qualquer conta sem roteador ativo.
- APIs novas: `/api/ai/agents` (listar/criar agentes extras — só o
  agente padrão continua editável em `/api/ai/config`, com o conjunto
  completo de recursos: fallback chain, embeddings, agenda; agentes
  extras são mais enxutos de propósito), `/api/ai/agents/[id]`
  (editar/excluir), `/api/ai/routers` (listar/criar),
  `/api/ai/routers/[id]` (editar, incluindo ativar/desativar com
  guarda contra roteador sem nenhuma intenção configurada),
  `/api/ai/routers/[id]/members` (substitui a lista de intenções por
  completo).
- UI: nova aba "Agentes e Roteador" em `/agents` (admin+) —
  `src/components/agents/ai-agents-list.tsx` (lista + criar/excluir
  agente) e `ai-routers.tsx` (lista de roteadores, toggle ativo,
  editor com confiança mínima, sticky, agente de fallback e a lista de
  intenções → agente).
- Guarda pro risco que a spec apontava ("`is_default` sem agente
  algum"): excluir o agente padrão via `DELETE /api/ai/config`
  promove automaticamente o agente mais antigo remanescente antes de
  apagar — nunca sobra uma conta com agentes mas sem nenhum default.
- Testado: `src/lib/ai/router.test.ts` (9 casos).
- Spec: [`multi-agent-router.md`](../specs/multi-agent-router.md).

### Navegação agrupada
- `src/components/layout/sidebar.tsx`: array plano `navItems` (10
  itens) virou `navGroups` — 4 grupos com cabeçalho (Atendimento, CRM,
  Agente de IA, Canais), escondidos em modo colapsado (rail) igual a
  qualquer outro texto do sidebar hoje.
- Novo item "Conexões" no grupo Canais, apontando pra
  `/settings?tab=whatsapp` (a tela de canais WAHA/Cloud API
  implementada antes) — o item que a spec original só deixou
  comentado como follow-up.
- `isActive` passou a comparar só a parte do path (antes de `?`), já
  que esse novo item carrega query string e `usePathname()` nunca
  inclui uma.
- Badge "beta" do Flows, dot de unread do Inbox e badge de
  notificações continuam idênticos — mesmo JSX, só reindentado dentro
  do loop de grupos.
- Nenhuma rota mudou de URL — reorganização só visual.
- Verificado visualmente no navegador (sessão já logada): os 4 grupos
  renderizam corretos, com todos os 10 itens redistribuídos e nenhum
  perdido.
- Spec: [`grouped-navigation.md`](../specs/grouped-navigation.md).

## Pendente — specs escritas, aguardando implementação

| Spec | Prioridade (PRD) | O que falta |
|---|---|---|
| [`signup-onboarding-wizard.md`](../specs/signup-onboarding-wizard.md) | — | Tudo — sem wizard, sem `accounts.onboarding_state`. |

## Decisão de produto pendente (nem é spec ainda — precisa validar com dados reais antes)

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
