# Spec: Múltiplos agentes de IA + Roteador de intenção

> Explorat贸rio/arquitetural — segundo dos quatro specs desta rodada.
> Depende conceitualmente de `specs/waha-channel-connection.md` (o
> roteador escolhe por conversa/canal, então "canal" precisa existir
> como conceito de primeira classe primeiro), mas pode ser implementado
> em paralelo se o passo 1 abaixo (multi-agente) andar antes do
> `channel_id` em `conversations` — só o passo 3 (roteamento por canal)
> realmente precisa da outra spec fechada.

## Problem

wacrm tem **exatamente um** agente de IA por conta:
`ai_configs.account_id` é `NOT NULL UNIQUE` (migration 029, linha 47).
Isso significa que uma conta que atende, por exemplo, vendas e suporte
no mesmo número — ou vendas e suporte em números WAHA diferentes depois
do spec anterior — não pode ter um agente com tom/prompt/base de
conhecimento diferente por área. Todo mundo cai no mesmo prompt.

O deskcomm resolve isso com dois conceitos separados: `ai_agents` (N por
conta, cada um com seu próprio prompt/modelo/base) e um **Intent
Router** (`ai_routers`/`ai_router_members`, `lib/agent-engine/agent/
router-config.ts`) que classifica a mensagem por sessão de canal e
decide qual agente responde, com um agente de fallback e um modo
"sticky" (uma vez roteada para um agente, a conversa fica com ele até o
fim, em vez de re-classificar toda mensagem).

## Non-goals

- **Reescrever o motor de auto-reply do zero.** `dispatchInboundToAiReply`
  (`src/lib/ai/auto-reply.ts:93`) já tem toda a lógica de cap, throttle,
  handoff e claim atômico (`claim_ai_reply_slot`, migration 031) — o
  roteador só decide **qual config carregar**, no ponto onde hoje há
  uma única chamada a `loadAiConfig(db, accountId)` (linha 107).
- **RAG por agente nesta fase.** A base de conhecimento
  (`ai_knowledge`, migration 030) é hoje account-scoped e compartilhada.
  Manter assim: todo agente da conta lê a mesma base. Separar por agente
  é um follow-up se surgir demanda (ex.: base de vendas vs. base de
  suporte).
- **Classificador customizado por conta.** Seguir o modelo do deskcomm:
  modelo/provedor do classificador é configurável no roteador, mas o
  próprio ato de classificar ("qual das N intenções isso é") usa o
  mesmo provedor BYO-key da conta — não um serviço de classificação
  separado.
- **Migrar contas existentes automaticamente para "múltiplos agentes".**
  Uma conta com 1 agente continua funcionando exatamente como hoje, sem
  roteador — o roteador é opt-in.

## Current behavior

- `ai_configs`: 1 linha por conta (`account_id UNIQUE`), guarda
  provider/model/api_key/system_prompt/auto_reply_* tudo junto.
- `dispatchInboundToAiReply` (`src/lib/ai/auto-reply.ts:93-108`): recebe
  `accountId`, chama `loadAiConfig(db, accountId)` uma vez, e todo o
  resto da função (cap de respostas, handoff, claim de slot) opera sobre
  essa única config.
- UI: uma única tela em `/agents` (`src/app/(dashboard)/agents/page.tsx`)
  edita a config única da conta.
- Nenhum conceito de "canal" na conversa hoje — `conversations` não tem
  `channel_id` (depende do spec anterior para isso existir de forma
  útil).

## Proposed change

### 1. Esquema: `ai_configs` deixa de ser único por conta

Renomear conceitualmente (migration, não mexe no nome da tabela para não
quebrar FKs existentes) — ou criar `ai_agents` nova e migrar:

```sql
-- Opção mais simples: soltar o UNIQUE, adicionar identidade própria.
ALTER TABLE ai_configs DROP CONSTRAINT ai_configs_account_id_key;
ALTER TABLE ai_configs ADD COLUMN name text NOT NULL DEFAULT 'Assistente';
ALTER TABLE ai_configs ADD COLUMN is_default boolean NOT NULL DEFAULT false;
-- Garantir exatamente 1 default por conta quando existir mais de 1 agente:
CREATE UNIQUE INDEX idx_ai_configs_account_default
  ON ai_configs (account_id) WHERE is_default;
```

A conta com 1 agente hoje ganha `name = 'Assistente'`, `is_default =
true` — comportamento idêntico, zero migração de dados perceptível para
quem não usa múltiplos agentes.

### 2. Roteador — nova tabela, editável (não versionada)

```sql
CREATE TABLE ai_routers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES whatsapp_channels(id) ON DELETE CASCADE, -- NULL = todos os canais da conta
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  classifier_model text,          -- NULL = usa o modelo do agente default
  min_confidence numeric NOT NULL DEFAULT 0.6,
  sticky boolean NOT NULL DEFAULT true,
  fallback_agent_id uuid REFERENCES ai_configs(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
-- No máximo 1 roteador ativo por (account_id, channel_id) — espelha a
-- doutrina do deskcomm (índice parcial da migration 0085 de lá).
CREATE UNIQUE INDEX idx_ai_routers_active_per_channel
  ON ai_routers (account_id, channel_id) WHERE is_active;

CREATE TABLE ai_router_members (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  router_id uuid NOT NULL REFERENCES ai_routers(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES ai_configs(id) ON DELETE CASCADE,
  intent_name text NOT NULL,
  intent_description text NOT NULL,
  examples text[] NOT NULL DEFAULT '{}',
  position integer NOT NULL DEFAULT 0
);
```

`channel_id` nullable = roteador de conta inteira (útil enquanto o spec
WAHA não estiver implementado, ou para quem só tem 1 canal mas quer
separar por intenção mesmo assim).

### 3. Ponto de resolução — um `loadAiConfig` a mais, no MESMO lugar

Em `dispatchInboundToAiReply` (`auto-reply.ts:107`), antes de
`loadAiConfig(db, accountId)`:

```ts
const router = await loadActiveRouter(db, accountId, conversation.channel_id)
const config = router
  ? await resolveAgentViaRouter(db, router, conversationContext)
  : await loadAiConfig(db, accountId) // comportamento atual, sem router
```

`resolveAgentViaRouter` chama o classificador (um prompt curto: lista de
intenções + exemplos → devolve o `intent_name` mais provável + score),
compara com `min_confidence`, e:
- score ≥ mínimo → carrega o `ai_configs` daquele `agent_id`.
- score < mínimo ou sem match → `fallback_agent_id` (ou o agente
  `is_default` da conta, se o roteador não tiver fallback).
- **sticky**: se a conversa já tem um `ai_configs` atribuído nesta
  sessão (nova coluna `conversations.active_ai_agent_id`, preenchida na
  primeira classificação), pula a classificação e usa o mesmo agente —
  só reclassifica se a conversa reabrir do zero (mesma semântica do
  deskcomm: "resolvido no início de cada turno, sem cache de processo,
  mas sticky guarda o resultado no lado do dado, não em memória").
- Falha silenciosa por design: **erro no classificador nunca derruba o
  turno** — cai no agente default da conta, igual à doutrina do
  deskcomm ("leitura defensiva do config, shape errado cai no default").

Nada em `buildConversationContext`, no cap de respostas, no handoff ou
no claim atômico muda — eles já operam sobre "a config resolvida",
qualquer que seja a origem.

### 4. UI

- `/agents` deixa de ser uma tela de edição única e passa a ser uma
  lista (nome, provider/model, badge "Padrão da conta"), com "+ Novo
  agente". Editar um agente é o MESMO formulário de hoje, só que
  endereçado por id em vez de implícito por conta.
- Nova tela `/agents/routers` (ou aba dentro de `/agents`): lista de
  roteadores, cada um com sua tabela de intenções → agente, o agente de
  fallback, e o toggle de ativo. Isso é literalmente o "Roteadores" do
  menu agrupado do deskcomm (ver `specs/grouped-navigation.md`).

## Acceptance criteria

- [ ] Uma conta com 1 agente (o caso de hoje) continua respondendo
      exatamente igual, sem nenhuma tela nova visível, sem roteador
      ativo.
- [ ] Uma conta pode criar um 2º, 3º... agente, cada um com seu próprio
      prompt/modelo/BYO-key.
- [ ] Um roteador ativo classifica a primeira mensagem de uma conversa
      nova e atribui um agente; mensagens seguintes na mesma conversa
      usam o mesmo agente sem reclassificar (quando `sticky = true`).
- [ ] Confiança abaixo do mínimo cai no agente de fallback (ou no
      agente `is_default` se o roteador não configurou fallback) —
      nunca falha o turno.
- [ ] O cap de respostas por conversa, o handoff por limite e o claim
      atômico de slot continuam funcionando idênticos, agora
      parametrizados pela config resolvida em vez de uma fixa.

## Risks / open questions

- **Custo de classificação**: cada conversa nova com roteador ativo
  gasta uma chamada de LLM extra (a classificação) antes da resposta
  em si. Para contas de alto volume isso dobra o custo de "primeira
  mensagem". Vale considerar um classificador mais barato/rápido por
  padrão (ex. um modelo pequeno) independente do modelo do agente,
  como o deskcomm já faz (`classifier_model`/`classifier_provider`
  separados do modelo do agente).
- **RAG compartilhado entre agentes pode confundir**: um agente de
  "suporte técnico" recuperando FAQ de "vendas" pode responder fora do
  tom. Fica como non-goal aqui, mas é o primeiro follow-up natural se o
  roteador for adotado.
- **Depende do spec de canais para o caso multi-número real** — sem
  `whatsapp_channels`/`conversations.channel_id`, o roteador só pode
  operar em "toda a conta", que ainda é útil (separar por intenção
  dentro do mesmo número) mas não separa por número.
- **`is_default` sem agente algum**: uma conta pode, em teoria, apagar
  o agente default sem escolher outro — precisa de uma guarda (não
  deixar apagar o único `is_default = true`, ou promover
  automaticamente outro agente quando o default é removido).
