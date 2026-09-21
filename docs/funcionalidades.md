# Funcionalidades do wacrm

CRM self-hostable para WhatsApp construído em Next.js 16 + Supabase.
Documento de referência das capacidades do sistema (código na branch `main`).

> Toda a autorização é feita por **RLS do Postgres** + papéis por conta.
> Papéis: `owner > admin > agent > viewer`.

---

## 1. Contas e equipe (multi-tenant)

- **Contas compartilhadas** — cada instalação é isolada por `account_id`; um
  número de WhatsApp pertence a exatamente uma conta.
- **Uso individual** — conta pessoal criada automaticamente no cadastro, sem
  configuração.
- **Convite de membros por link** — token com hash (SHA-256), expiração, papel
  pré-definido, rótulo opcional. Página `/join/<token>` mostra "Você foi
  convidado para <Conta> como <Papel>" antes do login.
- **Papéis e permissões** (`owner`, `admin`, `agent`, `viewer`) — predicados de
  capacidade centralizados (`canManageMembers`, `canEditSettings`,
  `canSendMessages`, …), aplicados tanto na API quanto na UI.
- **Gestão de membros** — mudar papel de um membro, remover membro (vira dono de
  uma nova conta pessoal, não perde o login), transferência de propriedade da
  conta (atômica).
- **Presença de equipe** — status online / ausente / offline por heartbeat;
  visível no roster e no seletor "Atribuir" do inbox. Tempo real.

## 2. Autenticação e conta do usuário

- Cadastro com e-mail/senha + confirmação por e-mail (Supabase Auth).
- Login, recuperação de senha (`/forgot-password`).
- Perfil: nome, e-mail, avatar (upload no bucket `avatars`, 2 MB).
- Troca de senha.
- Sessões ativas e **logout global** (encerra todas as sessões).
- Feature flags por conta (`profiles.beta_features`) para liberar recursos beta.

## 3. Inbox compartilhado (WhatsApp Business API oficial)

- **Múltiplos agentes em um número** — conversas atribuíveis por agente.
- **Status da conversa** — aberta / pendente / fechada.
- **Atribuição** a um agente + **notificação** ao agente atribuído (tempo real).
- **Reabertura automática** de conversa ao receber nova mensagem.
- **Deduplicação** — um contato = uma conversa por conta (garantia no banco,
  migração 036); um telefone = um contato por conta (migração 022).
- **Notas internas** por contato.
- **Contador de não lidas** com incremento atômico (sem perda em concorrência).
- **Tempo real** via Supabase Realtime (mensagens, conversas, reações).

### Mensagens

- Envio e recebimento de: texto, imagem, documento, áudio (nota de voz), vídeo,
  localização, template, mensagens interativas.
- **Composer com anexos** — foto / vídeo / documento / nota de voz gravada no
  navegador (WebM/Opus transcodificado para OGG antes do upload), salvos no
  bucket público `chat-media`.
- **Espelhamento de mídia recebida** — cópia da mídia recebida para o Storage
  para sobreviver à retenção de ~30 dias da Meta (opt-out por conta,
  migração 039).
- **Responder a uma mensagem** (reply / citação) — link para a mensagem original.
- **Reações com emoji** — uma reação por ator por mensagem; agente e cliente.
- **Mensagens interativas** — botões de resposta e listas, tanto enviadas
  quanto recebidas (o toque do cliente vira uma mensagem com `reply_id`
  consultável).
- **Respostas rápidas** (`quick_replies`) — snippets reutilizáveis de texto ou
  de mensagem interativa, inseríveis pelo composer. Escopo de conta.
- Rastreamento de status por mensagem: enviando / enviada / entregue / lida /
  falhou.

## 4. Contatos

- Cadastro manual, edição, exclusão (histórico preservado — FKs `ON DELETE SET
  NULL`).
- **Importação CSV** com deduplicação.
- **Tags** coloridas (muitos-para-muitos) + gerenciador de tags.
- **Campos personalizados** — texto, e outros tipos; valores por contato.
- **Filtro por tags** server-side (RPC paginada, sem o limite de ~1000 linhas
  do PostgREST).
- Busca por nome / telefone / e-mail.
- Empresa, e-mail, avatar por contato.
- Telefone normalizado (coluna gerada, dígitos apenas) para dedupe confiável.

## 5. Pipelines de vendas (Kanban)

- Múltiplos pipelines por conta.
- Estágios ordenáveis e coloridos.
- **Deals** — título, valor, moeda, notas, data prevista de fechamento,
  status (`open` / `won` / `lost`), agente responsável (`assigned_to`).
- Deal vinculado a um contato e opcionalmente a uma conversa.
- **Moeda padrão por conta** (`accounts.default_currency`, ISO-4217) — usada em
  novos deals e em todos os totais agregados.
- Arrastar-e-soltar entre estágios (drag & drop).

## 6. Broadcasts (envio em massa)

- Uso de **templates aprovados pela Meta**.
- **Substituição de variáveis por destinatário** (`{{1}}`, `{{2}}`, …),
  congeladas no momento do planejamento.
- **Público-alvo**: filtro por tags / atributos, ou **upload de CSV** com
  seletor de arquivo.
- **Agendamento** (`scheduled_at`).
- Rastreamento de entrega e leitura por destinatário; contadores agregados
  incrementais no broadcast (enviadas / entregues / lidas / respondidas /
  falhas).
- **Retomada server-side** — se a aba do navegador fechar no meio do envio, um
  botão "Retomar" reprocessa pendentes e falhas; mutex de entrega
  (`delivery_locked_at`) evita envio duplicado (migração 038).
- Criação atômica (broadcast + destinatários numa transação; migração 037).
- Correlação com o `message_id` da Meta para atualizar status via webhook.

## 7. Automations (automação no-code — linear)

Gatilho → lista linear de passos com ramificações condicionais.

- **Gatilhos**: mensagem recebida, novo contato, palavra-chave, tag adicionada,
  resposta interativa, agendamento.
- **Passos**: enviar mensagem, condição (ramo sim/não), aguardar (wait
  durável), adicionar tag, webhook de saída, etc.
- **Waits duráveis** — o passo `Wait` estaciona uma linha em
  `automation_pending_executions`, drenada por `GET /api/automations/cron`
  (segredo compartilhado em `x-cron-secret`, comparado com `timingSafeEqual`).
- **Logs de execução** por automação (sucesso / parcial / falha, passos
  executados, mensagem de erro).
- Ativar/desativar, **duplicar** automação.
- Validação no salvamento (arestas órfãs / faltantes).
- Contador de execuções atômico.
- Construtor visual.

## 8. Flows (chatbot conversacional stateful — grafo)

Grafo de conversa por contato, editado com `@xyflow/react`.

- **Tipos de nó**: `start`, `send_message`, `send_buttons`, `send_list`,
  `send_media`, `collect_input`, `condition`, `set_tag`, `handoff`,
  `http_fetch`, `end`.
- Arestas vivem **dentro** da config do nó (`next_node_key` — string estável,
  não UUID), então flows podem ser clonados e usados como template.
- **Gatilhos**: palavra-chave, primeira mensagem recebida, manual.
- **Estado por contato** (`flow_runs`) — suspende em nós que esperam input do
  cliente e retoma na próxima resposta.
- **Concorrência segura**: idempotência por `meta_message_id`, UPDATE otimista
  travado em `current_node_key`, índice único parcial (uma run ativa por
  contato por conta).
- **Política de fallback** — reprompt, máx. de reprompts, timeout em horas,
  ação ao esgotar (handoff).
- **Sweeper de timeout** via `GET /api/flows/cron`.
- **Nó `http_fetch`** — chamada HTTP externa com SSRF-guard (bloqueia faixas
  privadas); resposta interpolável em nós seguintes.
- **Templates de flow** prontos (`/api/flows/templates`).
- **Histórico de runs** (`/flows/[id]/runs`) — trilha de auditoria append-only
  (`flow_run_events`).
- Upload de mídia do builder (bucket `flow-media`, escopo de conta).
- Ativação com validação; contador de execuções atômico.

> Automations e Flows são sistemas **separados**. O webhook decide qual
> consumiu a mensagem para não disparar os dois.

## 9. Assistente de IA (traga sua própria chave)

- **BYO key** — cada conta cola sua própria chave OpenAI ou Anthropic;
  armazenada AES-256-GCM sob `ENCRYPTION_KEY`. Sem provedor global.
- **System prompt** configurável (contexto do negócio / persona / tom).
- **Rascunho com IA** no inbox — resposta sugerida em 1 clique.
- **Auto-reply bot** opcional:
  - Cap por conversa (`auto_reply_max_per_conversation`, 1–20) com claim de
    slot atômico (`claim_ai_reply_slot`) — webhooks concorrentes não
    respondem em dobro.
  - **Handoff limpo para humano** — regras em `lib/ai/handoff.ts`; ao sinalizar
    handoff, a conversa é roteada para um agente (`handoff_agent_id`) ou cai na
    fila, com resumo interno (`ai_handoff_summary`) para o agente que assume.
  - Sticky: uma vez em handoff, fica desligado até reativação explícita.
- **Base de conhecimento** (RAG) — FAQs, políticas, docs de produto:
  - **Retrieval híbrido**: FTS do Postgres (`match_ai_knowledge_fts`) sempre;
    busca semântica pgvector (`match_ai_knowledge_semantic`) quando há chave de
    embeddings.
  - Documentos → chunks; embeddings OpenAI `text-embedding-3-small` (1536 dims),
    índice HNSW.
  - Reindexação sob demanda (`/api/ai/knowledge/reindex`).
- **Playground** — testar prompt/comportamento sem afetar conversas.
- **Log de uso de tokens** (`ai_usage_log`) — por chamada (rascunho ou
  auto-reply), tokens de prompt/completion/total; visível só para admin+.
- Badge "AI" nas bolhas de mensagem geradas por IA.
- Timeout de request e limite de contexto configuráveis por env
  (`AI_REQUEST_TIMEOUT_MS`, `AI_CONTEXT_MESSAGE_LIMIT`).

## 10. Templates de mensagem (Meta)

- Criar / editar / submeter templates para aprovação da Meta.
- Categorias: Marketing, Utility, Authentication.
- Cabeçalho: texto, imagem, vídeo, documento.
- Corpo com variáveis, rodapé, botões (quick reply / CTA), até 10 botões.
- **Sincronização** com a Meta (`/api/whatsapp/templates/sync`) — importa
  status reais (PAUSED, DISABLED, IN_APPEAL, etc.).
- Motivo de rejeição e **quality score** (GREEN / YELLOW / RED) via webhook.
- Header de imagem via Resumable Upload (requer `META_APP_ID`).
- Modo dry-run (`WHATSAPP_TEMPLATES_DRY_RUN`) para desenvolvimento sem WABA
  real.

## 11. Configuração do WhatsApp

- Salvar credenciais: `phone_number_id`, `waba_id`, access token
  (criptografado), verify token.
- **Registro na Cloud API** — `POST /{phone_number_id}/register` (com PIN 2FA) +
  `POST /{waba_id}/subscribed_apps`; a UI distingue "credenciais salvas" de
  "de fato ativo".
- **Verificação de registro** (`/api/whatsapp/config/verify-registration`) —
  diagnóstico e retry.
- Um número por conta (índice único, migração 013).
- Opt-out de espelhamento de mídia recebida.

## 12. Webhook de entrada (porta de entrada do sistema)

- Verificação de assinatura HMAC-SHA256 contra `META_APP_SECRET`.
- Resolução da conta por `metadata.phone_number_id`.
- Resolução/dedupe de contato, resolução/reabertura de conversa, persistência da
  mensagem, espelhamento de mídia.
- **Fan-out em `after()`** (retorna 200 imediato para a Meta): Flows engine →
  Automations engine → AI auto-reply → webhooks de saída.
- **Idempotência** em `meta_message_id` em todos os consumidores (a Meta faz
  retry agressivo).

## 13. Dashboard e relatórios

- **Tempos de resposta**, volume diário de mensagens, valor do pipeline.
- **Feed de atividade** cross-module (contatos, deals, conversas, …).
- Atualização em tempo real.

## 14. Notificações

- Notificação in-app ao ser atribuído a uma conversa (tempo real).
- Marcar como lida (privilégio de coluna: cliente só edita `read_at`).
- Página dedicada (`/notifications`).

## 15. API pública REST (`/api/v1`)

- Versionada e estável.
- **Bearer keys** `wacrm_live_…` — SHA-256 em repouso, prefixo não-secreto para
  exibição, criadas/revogadas no dashboard (Settings → API keys, admin+).
- **Autorização por escopo** (`lib/api-keys/scopes.ts`) — novo escopo é mudança
  de código, não migração.
- **Rate limiter** de janela fixa em memória (1 processo Node).
- Envelope de resposta uniforme (`lib/api/v1/respond.ts`).
- Endpoints: `me`, `contacts` (list/get/create/update/delete),
  `conversations` (list/get/update + `messages`), `messages` (send),
  `broadcasts` (list/get/create), `webhooks` (CRUD).
- Isolamento de tenant **manual** (`.eq("account_id", ...)` em toda query).

## 16. Webhooks de saída (outbound)

- Endpoints HTTPS registrados por conta (admin+).
- Assinatura **HMAC** de cada payload; segredo AES-256-GCM em repouso,
  devolvido ao criador uma única vez.
- **SSRF-guard** (`ssrf.ts` bloqueia faixas privadas / `isDeliverableUrl`).
- Filtro por tipo de evento (`events[]` — mensagem recebida, mudança de status,
  conversa criada, …).
- **Auto-desativação** após N falhas consecutivas (contador atômico
  `record_webhook_failure`); sucesso zera o contador.

## 17. Servidor MCP (`mcp-server/`)

- Pacote npm separado (`wacrm-mcp`), cliente fino sobre `/api/v1` — sem lógica
  de negócio, sem acesso ao banco.
- Dirige o CRM a partir de Claude, Cursor e outros clientes MCP.
- **Read-only por padrão**; escritas opt-in via `WACRM_ENABLE_WRITES`,
  broadcasts via `WACRM_ENABLE_BROADCASTS`.
- Ferramentas de leitura, escrita e broadcast (`mcp-server/src/tools/`).

## 18. Configurações (Settings)

- **Perfil** — nome, avatar, e-mail.
- **Segurança** — senha, sessões ativas, logout global.
- **Aparência** — tema de acento (`data-theme`) e modo claro/escuro
  (`data-mode`), aplicados por script inline antes da hidratação (sem flash).
- **Membros** — convidar, papéis, remoção, transferência de propriedade.
- **Campos e tags** — campos personalizados, gerenciador de tags.
- **Deals** — moeda padrão da conta.
- **WhatsApp** — credenciais e registro.
- **Templates** — gerenciador de templates de mensagem.
- **Respostas rápidas** — gerenciador de snippets.
- **Assistente de IA** — provedor, modelo, chave, system prompt, auto-reply,
  base de conhecimento, uso de tokens.
- **API keys** — criar / revogar chaves da API pública.
- **Agents** (`/agents`) — página de agentes.

## 19. Internacionalização

- **Single-locale em build-time** (não por request): `NEXT_PUBLIC_APP_LOCALE`,
  fallback `en`. Sem segmento de locale na URL.
- Dicionários em `messages/` (`en.json`, `ko.json`, …).
- Testes de paridade de chaves e segurança de ICU (`src/i18n/*.test.ts`) — CI
  falha se uma string existir só em um idioma.

## 20. Segurança (primitivas)

- Criptografia de tokens AES-256-GCM (`ENCRYPTION_KEY`, 64 hex).
- **RLS em toda tabela** — autorização é Postgres, não código de aplicação.
- Mutações privilegiadas via RPCs `SECURITY DEFINER` (redenção de convite,
  mudança de papel, remoção de membro, transferência de propriedade).
- Webhooks verificados por HMAC (entrada e saída).
- SSRF-guard para toda URL fornecida pelo usuário que o servidor vá buscar.
- Guard de colunas de privilégio em `profiles` (trigger BEFORE UPDATE impede
  auto-promoção via PostgREST — migração 034).
- Retrieval da KB como `SECURITY INVOKER` (impede leitura cross-account —
  migração 032).
- CSP em modo `Report-Only` (`next.config.ts`).
- Rate limiting na API pública.
- CI: lint → typecheck → test → build em todo PR; workflow de migrações replaya
  o schema do zero e valida contra `verify-schema.sql`.

## 21. Deploy e operação

- `output: "standalone"` (Next.js).
- Docker + Docker Compose (`docs/docker.md`).
- Deploy recomendado: Hostinger (Git deploy, Node.js gerenciado, SSL grátis).
- Roda em qualquer lugar com Node.js (Vercel, Railway, VPS).
- Três endpoints de cron/máquina protegidos por segredo:
  `/api/automations/cron`, `/api/flows/cron`, engine de automations.
- Rotação de `ENCRYPTION_KEY` órfã todos os ciphertexts — sem caminho de
  re-criptografia.
