# Status: melhorias inspiradas no DeskcommCRM + conexão WAHA

> Documento de rastreio, não uma spec. Objetivo único: qualquer sessão
> futura (esta ou outra) consegue abrir este arquivo e saber, sem
> reconstruir contexto, o que já foi feito e o que ainda é só uma spec
> escrita. Atualize esta lista sempre que uma spec referenciada aqui
> for implementada ou uma nova for aberta.
>
> PRD-mãe: [`prd-melhorias-inspiradas-no-deskcomm.md`](prd-melhorias-inspiradas-no-deskcomm.md).
> Última revisão: 2026-09-29 (PWA + Web Push implementado).
> Migrations 064-071 (throttle WAHA, audit log, multi-agente,
> onboarding, rodízio de broadcast, responsáveis por canal, inbox
> power features, push subscriptions) foram
> aplicadas ao banco real via MCP do Supabase — confirmado por
> `list_migrations`. Qualquer migration nova a partir de agora precisa
> do mesmo passo explícito antes de virar "funcionando em produção".

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

### Wizard de onboarding pós-cadastro
- Migration 067: `accounts.onboarding_state jsonb` + `onboarded_at
  timestamptz`, com backfill de `onboarded_at = now()` pras contas já
  existentes (non-goal explícito da spec: sem onboarding retroativo
  forçado).
- `src/lib/onboarding/steps.ts` — lista única (`STEPS`) de onde o
  roteador, o indicador de progresso e o resumo final derivam, igual à
  doutrina do deskcomm citada na spec. Sem o `applies(ctx)` do
  rascunho original: nenhum passo condicional existe hoje, então essa
  parte da interface foi cortada até haver um caso real.
- `src/app/onboarding/*` — layout com stepper + link "Pular onboarding
  e ir para a Caixa de entrada" sempre visível; roteador raiz que
  resolve o próximo passo incompleto; 5 telas (`welcome`, `channel`,
  `ai-agent`, `test`, `team`) cada uma com "Pular por agora"; `done`
  com resumo feito/pulado por passo.
- Passos reaproveitam componentes já existentes em vez de duplicar:
  `channel` embute `WhatsAppConfig`/`WahaChannels` (as mesmas telas de
  Configurações), `ai-agent` embute `AiConfig`, `team` embute
  `InviteMemberDialog`, `test` embute o `AiPlayground` (ganhou um
  `onReplyReceived` novo, aditivo) — resposta real do provedor
  configurado, não uma resposta fake.
- **Recorte consciente**: o "fuso horário" que o rascunho da spec
  citava no passo `welcome` foi removido — não existe coluna/conceito
  de timezone em `accounts` hoje, só `NEXT_PUBLIC_APP_LOCALE`
  (idioma). Adicionar isso seria inventar escopo que a spec não pediu
  de verdade.
- `signup/page.tsx`: `emailRedirectTo` agora aponta pra `/onboarding`
  também no caso sem convite (antes só o caso com convite setava
  redirect). Convite continua indo pra `/join/<token>`, sem passar
  pelo wizard.
- Testado: `src/lib/onboarding/steps.test.ts` (8 casos, lógica pura de
  resolução/marcação de passos).
- **Verificado ao vivo no navegador** (sessão real já logada): acessar
  `/onboarding` redirecionou pra `/onboarding/welcome` corretamente; o
  link "Pular onboarding" persistiu e redirecionou pra `/dashboard`.
  Isso revelou uma coisa importante — ver o alerta abaixo.
- Spec: [`signup-onboarding-wizard.md`](../specs/signup-onboarding-wizard.md).

## ⚠️ Migrations pendentes de aplicar no banco real

Confirmado ao vivo em 2026-09-28: o teste do onboarding no navegador
mostrou o erro `Could not find the 'onboarded_at' column of 'accounts'
in the schema cache` — ou seja, **as migrations 064
(`waha_send_throttle`), 065 (`audit_log`), 066
(`ai_multi_agent_router`) e 067 (`onboarding_state`) nunca foram
aplicadas ao banco de produção**, só existem como arquivo `.sql` no
repo. O código degrada com segurança (não quebra, só não persiste),
mas nenhuma dessas quatro features funciona de verdade até rodar as
migrations pendentes (`supabase db push` ou equivalente) — mesmo ponto
que já tinha sido levantado no início desta rodada de conversas.

## Pendente — specs escritas, aguardando implementação

Todas as specs da rodada anterior (PRD +
`agenda-exploratory.md`/`waha-channel-connection.md`/
`multi-agent-router.md`/`grouped-navigation.md`/
`signup-onboarding-wizard.md`/`audit-log-endurecido.md`/
`waha-anti-banimento-e-opt-out.md`) estão implementadas.

As specs da rodada anterior (PRD + as 3 abaixo do título) estão todas
implementadas. **Nova rodada (2026-09-29)**, escrita depois de comparar
com o deskcomm e de ouvir o caso da barbearia (o operador cuida do
WhatsApp e da agenda do cliente): 8 specs, na ordem sugerida de
implementação. Nenhuma tem código ainda.

| # | Spec | O que resolve |
|---|---|---|
| 1 ✅ | [`handoff-customer-notice.md`](../specs/handoff-customer-notice.md) | Quando a IA repassa para humano o **cliente não recebe nada** (achado nos 4 caminhos de `handOffToHuman`, mais 2 que retornam calados) e a nota interna é uma frase em inglês fixa, cortada numa linha. Guarda o *motivo* e não a frase, renderiza traduzido e legível, e manda um aviso ao cliente (varia por motivo, por disponibilidade da equipe e por conversa). Pequena, e conserta um buraco que o usuário viu em produção. |
| 2 | [`scheduled-broadcasts.md`](../specs/scheduled-broadcasts.md) | Disparo agendado — **já existia como spec e continua sem código** (`scheduled_at` existe desde a migration 001 e nada usa). Atualizada com pausa/retomada, janela de envio, compatibilidade com o rodízio WAHA e o filtro de consentimento. |
| 3 | [`followup-sequences.md`](../specs/followup-sequences.md) | Follow-up em sequência quando o cliente esfria. Substitui `ai-conversation-followup-on-silence.md`. O achado central: hoje **uma espera já armada não pode ser cancelada**, então não dá para montar follow-up seguro com as peças atuais — a spec adiciona as condições de parada (cliente respondeu, humano assumiu, fechou, opt-out) em três camadas. |
| 4 | [`human-cases.md`](../specs/human-cases.md) | "Casos": a IA continua falando com o cliente enquanto um colega resolve uma tarefa de retaguarda e responde *para a IA*. Não substitui o aviso do item 1 (situações diferentes). Tem uma restrição que o deskcomm não tem: a janela de 24h da API oficial. |
| 5 | [`ai-agents-management.md`](../specs/ai-agents-management.md) | Agentes gerenciáveis: hoje um agente que não é o padrão só pode ser criado e apagado na tela (a API já edita, a UI não); modelo é campo de texto livre. Traz seletor de modelos vindo do provedor, página de edição, uso por agente e (fase 2) histórico com restauração. |
| 6 | [`prospecting-csv-import.md`](../specs/prospecting-csv-import.md) | Prospecção completa a partir de um CSV (decisão: a fonte é planilha própria, sem a busca por API do deskcomm). **Parte A:** importação no servidor (`;`, Latin-1, relatório por linha) com portão de consentimento. **Parte B:** campanha de prospecção só em número WAHA — cada contato vira negócio no funil, a IA escreve a abordagem, envio lento (teto diário, aquecimento, intervalo com variação, janela de horário, saída em toda mensagem), o mesmo agente atende a resposta e move o negócio para "qualificados" (nova ferramenta `move_deal_stage`). Funil por campanha: enviados → responderam → qualificados. |
| 7 | [`google-calendar-sync.md`](../specs/google-calendar-sync.md) | Agendamentos vão para o Google Agenda do dono e eventos do Google bloqueiam horários para a IA. A maior incerteza não é código: é a verificação do app pelo Google. |
| 8 | [`operator-multi-account.md`](../specs/operator-multi-account.md) | Modo operador: uma pessoa cuidando de vários clientes (a barbearia). Hoje o convite **recusa** quem já está numa conta. Traz memberships com conta ativa, carteira de saúde por cliente, experiência "essencial" e links para o cliente conectar QR/Google sem passar senha. |
| 9 | [`ai-output-guardrails.md`](../specs/ai-output-guardrails.md) | Hoje toda regra de segurança da IA é uma frase no prompt: nada confere o texto antes de sair. O deskcomm tem uma cadeia fixa de verificações entre o modelo e o cliente (opt-out, tabela de preço/desconto/parcelas, promessa de humano sem repasse, vazamento de vocabulário interno, aviso de assistente virtual), com rastro por verificação. Propõe as cinco determinísticas (sem custo de IA), em modo só-observar antes de bloquear. |
| 10 | [`product-differentiators.md`](../specs/product-differentiators.md) | Nota estratégica (sem pesquisa de mercado): nenhum lead se perde (e medido), número protegido como recurso, IA que dá para governar, pacotes por nicho + modo operador, CRM operado pela própria IA (MCP). Vale para pequenos negócios operados por você e para empresas que gerem o próprio CRM. |

Ordem: 1 é pequena e urgente; 2 e 3 dependem da mesma decisão sobre a
frequência do cron; 4 usa os códigos de motivo do 1; 7 e 8 são o que
transforma o produto no serviço "eu opero o WhatsApp do cliente". Onde
duas specs se cruzam elas se citam pelo nome (ex.: o cron único, o
consentimento, os links de conexão).

### PWA + Web Push — ✅ implementado (falta configurar as chaves VAPID)
- **Instalável**: `src/app/manifest.ts` (`/manifest.webmanifest`,
  `display: standalone`, `start_url: /dashboard`), ícones 192/512 +
  maskable em `/pwa-icon/[size]`, `apple-icon` 180×180 pro iOS e
  `appleWebApp` no layout. Os três ícones e o favicon saem de um único
  `src/lib/brand-mark.tsx`, então não divergem.
- **Service worker** `public/sw.js`: só `push` + `notificationclick`,
  sem handler de `fetch` nem cache (não-objetivo do spec: inbox velho
  offline engana o atendente). Servido com `no-cache` e fora do
  matcher do middleware.
- **Migration 071** `push_subscriptions` (uma linha por
  aparelho/navegador, `endpoint` UNIQUE). Escrita só pela rota
  `/api/notifications/push-subscription` com service role — o mesmo
  endpoint pode trocar de dono num aparelho compartilhado. O endpoint
  passa pelo mesmo guard de SSRF dos webhooks de saída.
- **Envio** `src/lib/push/send.ts`: chamado pelos DOIS webhooks de
  entrada (Meta e WAHA), logo depois do ponto de idempotência (replay
  nunca dispara push duas vezes). Conversa atribuída → só o
  responsável recebe; não atribuída → todos da conta com push ligado.
  Assinatura que volta 404/410 é apagada na hora.
- **Settings → Perfil → Notificações**: toggle "Notificações push" +
  botão "Enviar push de teste" (`/api/notifications/push-test`, só pros
  seus aparelhos). No iPhone/iPad em aba do Safari aparece a instrução
  "Compartilhar → Adicionar à Tela de Início" em vez do toggle.
- **Corrige o bug original de Android** também no alerta de aba
  aberta: quando `new Notification()` lança exceção (Android Chrome), o
  alerta agora sai pelo service worker.
- **Para ligar em produção**: gerar um par de chaves uma vez
  (`npx web-push generate-vapid-keys`) e definir
  `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT`
  (documentado em `.env.local.example`). Sem elas, push fica desligado
  e o resto funciona igual.
- Testado: `send.test.ts` (limpeza 404/410, erro transitório não apaga,
  só o responsável recebe, sem VAPID = no-op) + `pwa.test.ts`
  (manifest, ícones, detecção de iOS). Verificado no navegador: manifest,
  ícones nos tamanhos certos, headers do `sw.js`, tags no `<head>`, o
  worker instala e ativa, API recusa sem login. `npm run build` ok.
  **Não testado**: a entrega real de um push num celular — precisa das
  chaves VAPID configuradas e de HTTPS (produção ou túnel).

### Rodízio de números no broadcast — ✅ implementado
- Migration 068: `broadcasts.primary_channel_id` (NULL = Cloud API,
  como sempre foi), `broadcast_recipients.sent_via_channel_id`,
  tabela `broadcast_channel_pool`. `create_broadcast_with_recipients`
  (037/038/041) ganhou `p_primary_channel_id` — a versão de 8
  argumentos foi **removida** (não só substituída) pra não sobrar duas
  funções fazendo quase a mesma coisa.
- `src/lib/whatsapp/broadcast-rotation.ts`: `pickNextChannel` — o
  canal do pool com `last_sent_at` mais antigo (nunca enviado vem
  primeiro), restrito a `status = 'connected'` (senão um canal
  desconectado pareceria "o mais livre" e seria escolhido sempre).
- `src/lib/whatsapp/broadcast-core.ts`: `createBroadcast` agora nem
  consulta `whatsapp_config` quando `primaryChannelId` é passado — uma
  conta só-WAHA já conseguia conectar canal antes, mas não conseguia
  disparar broadcast nenhum; isso fecha esse buraco. `deliverBroadcast`
  ganhou o branch WAHA: roda `pickNextChannel` → `claimWahaSendSlot`
  (throttle da migration 064, que decide *se* pode mandar; o rodízio
  decide só *qual* canal perguntar) → `sendWahaText`, sem retry de
  variante de telefone (não existe "recipient not allowed" no WAHA).
- `src/lib/whatsapp/broadcast-resume.ts`: o resume (`planBroadcastResume`)
  também aprendeu o mesmo split — antes exigia `whatsapp_config`
  incondicionalmente, o que quebraria retomar um broadcast WAHA.
- **Corrigido de passagem**: achei e corrigi um bug real que essa
  mudança expôs — `createBroadcast`'s `return` referenciava
  `config.phone_number_id` fora do escopo do bloco onde `config` foi
  declarado; só não quebrava porque o modo Cloud API sempre passava
  por ali antes. Ficou `phoneNumberId` (variável hoisted), corrigido
  como parte deste commit.
- `/api/v1/broadcasts` (a única rota que já chamava `broadcast-core.ts`
  — o wizard do dashboard usa uma rota antiga separada que nunca grava
  em `broadcast_recipients`, gap pré-existente e fora de escopo aqui)
  ganhou `primary_channel_id`/`channel_pool_ids` no corpo do POST.
- Testado: `broadcast-rotation.test.ts` (4 casos) +
  `broadcast-core.test.ts` (6 casos novos: 3 de `createBroadcast` WAHA,
  3 de `deliverBroadcast` WAHA).
- **Escopo deixado de fora**: o wizard visual de broadcast do dashboard
  (`src/components/broadcasts/*`) não ganhou seletor de canal — ele
  não usa `broadcast-core.ts`, então integrá-lo é um trabalho
  separado, não coberto aqui.
- Spec: [`broadcast-channel-rotation.md`](../specs/broadcast-channel-rotation.md).

### Responsáveis por canal — ✅ implementado
- Migration 069: `channel_routing_policies` (uma linha por canal;
  `waha_channel_id` NULL = o número da Cloud API, mesma convenção
  NULL-é-Cloud-API da 056) + `channel_routing_responsibles`
  (many-to-many pra `auth.users`). Sem policy = sem restrição
  (comportamento igual ao de antes desta feature); policy com zero
  responsibles = "restricted_empty" — um estado explícito de "ainda
  sem dono", diferente de "aberto pra todo mundo".
- **A aplicação de fato é um trigger em Postgres**
  (`enforce_channel_routing_assignment`, `BEFORE UPDATE` em
  `conversations`), não código de app — os dois pontos de escrita
  hoje (`conversation-list.tsx`, `message-thread.tsx`) fazem
  `.update()` direto do navegador via RLS, sem passar por nenhuma rota
  de API que um resolver em TS pudesse interceptar. O trigger só
  reage quando `assigned_agent_id` muda pra um valor não-nulo — uma
  atribuição já existente que fica inelegível depois (a policy foi
  criada depois, ou o responsável foi removido) não é desfeita
  retroativamente, como o próprio spec recomenda; desatribuir sempre é
  permitido.
- `src/lib/channels/routing.ts`: resolver compartilhado — versão
  single-conversation (`eligibleAssigneesForConversation`, usada por
  `GET /api/conversations/[id]/eligible-assignees`, que o
  `MessageThread` chama pra filtrar seu próprio dropdown) e versão
  batch (`loadChannelRoutingPolicies` + `policiesToMap` +
  `eligibleAssigneesFromMap`, usada pela lista do Inbox pra montar um
  mapa uma vez em vez de uma consulta por conversa).
- `GET/PUT/DELETE /api/settings/channel-routing`: leitura aberta a
  qualquer membro (os dropdowns de atribuição precisam ler pra
  filtrar), escrita `admin+` — mesmo corte que `/api/account/members`
  já usa.
- UI: nova aba "Responsáveis" em Settings → WhatsApp (junto de "API
  Oficial" e "Números por QR"), um card por canal (incluindo o slot da
  Cloud API) com diálogo de checkbox por membro da conta.
- Os dois dropdowns de atribuição (menu de contexto da lista, cabeçalho
  da thread) filtram a lista de perfis pelo resultado do resolver —
  um membro inelegível simplesmente não aparece como opção, em vez de
  aparecer e dar erro ao clicar.
- Testado: `src/lib/channels/routing.test.ts` (4 casos, lógica pura do
  lookup em Map).
- Spec: [`channel-routing-responsibles.md`](../specs/channel-routing-responsibles.md).

### Inbox power features — ✅ implementado
- Migration 070: `conversations.snoozed_until`, `conversation_tags`
  (reaproveita o catálogo `tags`; o `WITH CHECK` da RLS amarra a tag à
  mesma conta da conversa), `conversation_notes` (tabela própria, nunca
  linha em `messages` — nenhuma query do thread do cliente lê essa
  tabela, então uma nota interna não tem como vazar).
- **Snooze**: some da lista padrão e aparece num filtro novo
  "Adiadas". Volta sozinho quando o horário passa, sem cron — a lista já
  tinha um tick de 60s (do SLA), e `isSnoozed` é reavaliado nele. Uma
  mensagem nova do cliente limpa o snooze na hora: foi colocado dentro
  de `bump_conversation_on_inbound`, a função que os DOIS webhooks
  (Meta e WAHA) já chamam. Presets 1h / 3h / amanhã 9:00 no menu de
  contexto, só para conversas não-fechadas (recomendação do próprio
  spec). **Ficou de fora**: "data personalizada" — só os três presets.
- **Tags da conversa**: grupo novo no menu de contexto, separado das
  tags de contato; na linha aparecem com `#` e estilo contornado (as de
  contato continuam preenchidas). O filtro de tags do inbox passou a
  casar tag de contato OU de conversa. Deliberadamente **não** entram no
  filtro de audiência do Broadcast (broadcast mira pessoas).
- **Notas internas**: seção "Notas internas" no painel do contato
  (acima das notas do contato), cartão âmbar. Escrever: agent+, sempre
  como você mesmo (RLS confere `author_user_id = auth.uid()`). Apagar:
  a própria nota, ou admin+ qualquer uma. Sem edição — apaga e reescreve.
  **Limitação**: o painel do contato é só desktop, então no celular as
  notas não aparecem ainda.
- **Atalhos**: `src/hooks/use-inbox-shortcuts.ts` — `j`/`k`/setas
  navegam, `e` fecha, `r` foca a caixa de resposta, `s` abre o diálogo
  de snooze, `?` mostra a ajuda. Nunca disparam dentro de input/textarea,
  com IME compondo, com Ctrl/Cmd/Alt, nem com menu/diálogo aberto.
- Testado: `use-inbox-shortcuts.test.ts` (mapa de teclas, guarda de
  digitação, navegação) + `conversations.test.ts` (tags de conversa,
  `isSnoozed`, presets). **Não testado no navegador**: o app local
  aponta pro Supabase real e exige login — não entrei com credencial.
- Spec: [`inbox-power-features.md`](../specs/inbox-power-features.md).

## Gap conhecido — multi-número fora do Inbox

Confirmado em 2026-09-28 (e comparado com o deskcomm no mesmo dia): a
separação por canal (WAHA vs. Cloud API, ou WAHA A vs. WAHA B) só
existe de fato no **Inbox** (badge + filtro) e no **Broadcast**
(rodízio, acabou de ser implementado), e parcialmente no **Agente de
IA** (só se um Roteador estiver configurado com `channel_id`).
Dashboard e Automações/Flows são account-wide nos DOIS produtos (não é
só gap do wacrm). "Responsáveis por número" (`channel-routing-
responsibles.md`) foi implementado nesta sessão — esse gap específico
está fechado.

Também confirmado: `specs/billing-subscriptions.md` (exploratória, sem
código) cobre só "ter um plano pago" genérico — agora tem uma nota
registrando cobrança por número extra conectado como follow-up, sem
desenho ainda.

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
