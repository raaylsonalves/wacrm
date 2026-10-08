# Spec: Vários números oficiais (Meta Cloud API) por conta

**Status (2026-10-08): etapas 1, 2, 2b e 3 implementadas (migrations 112–118).**

## Problem

Uma conta só pode ter **um** número da API oficial da Meta. Quem quer operar
com mais de um número (pacote com vários números: vendas + suporte, filiais,
unidades) hoje só consegue pela conexão não oficial (WAHA / QR code), que
tem risco de banimento — e a maioria dos clientes não quer arriscar o número
principal fora da API oficial.

Surgiu em conversa com o dono do produto (Nordia Tech) em 2026-10-08, ao
pensar em pacotes com mais de um número.

## Non-goals

- **Mudar o WAHA.** Os números não oficiais (`whatsapp_waha_channels`,
  `specs/waha-channel-connection.md`) continuam como estão.
- ~~Uma conversa por número~~ — revisto na etapa 2b (abaixo): no teste real,
  o mesmo contato escrevendo para os dois números trocava a conversa de
  número; o esperado (como no WhatsApp Business) é uma conversa por número.
- **Embedded Signup / onboarding da Meta.** O cadastro do número continua
  manual (phone_number_id, WABA, token), como hoje.
- **Preço dos pacotes.** O limite de números por plano entra na etapa 3; os
  valores são decisão comercial ainda em aberto (ver Open questions).

## Current behavior

- `whatsapp_config` tem `UNIQUE(account_id)` (`whatsapp_config_account_id_key`,
  migration 017) e `UNIQUE(phone_number_id)` (migration 013).
- O webhook (`src/app/api/whatsapp/webhook/route.ts`) já resolve a conta pelo
  `metadata.phone_number_id` — o recebimento já sabe qual número recebeu.
- `conversations.whatsapp_channel_id` (migration 056): `NULL` = "o número
  oficial da conta", não nulo = um canal WAHA. Vários pontos dependem dessa
  convenção (janela de 24h, follow-ups, casos, roteamento).
- ~22 pontos leem "o" número da conta com
  `.from('whatsapp_config').eq('account_id', …).single()/.maybeSingle()`:
  envio (`lib/whatsapp/send-message.ts`, `broadcast-core.ts`,
  `broadcast-resume.ts`, `automations/meta-send.ts`, `flows/meta-send.ts`),
  modelos (`api/whatsapp/templates/*`), mídia, reações, prospecção,
  configurações e banner de status. Com duas linhas por conta, todos
  quebrariam (`.single()` erra com ≥2 linhas).
- `lib/whatsapp/template-webhook.ts` procura a conta por `waba_id` e exige
  exatamente 1 linha — dois números da mesma WABA quebrariam isso.

## Proposed change

### Etapa 1 — banco e recebimento (sem mudança visível)

Migration **112_multi_official_numbers.sql**:

```sql
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS label text;
-- Troca "um número por conta" por "um número PRINCIPAL por conta".
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_primary_per_account
  ON whatsapp_config (account_id) WHERE is_primary;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id uuid
    REFERENCES whatsapp_config(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON conversations (whatsapp_config_id) WHERE whatsapp_config_id IS NOT NULL;
-- Backfill: conversas oficiais existentes -> o número (único) da conta.
UPDATE conversations c SET whatsapp_config_id = w.id
  FROM whatsapp_config w
  WHERE w.account_id = c.account_id AND w.is_primary
    AND c.whatsapp_channel_id IS NULL AND c.whatsapp_config_id IS NULL;
```

Semântica: `whatsapp_channel_id IS NULL` continua significando "API oficial";
`whatsapp_config_id` diz QUAL número oficial (NULL = o principal).

Código:
- Toda leitura de "o número da conta" passa a filtrar `.eq('is_primary', true)`
  — com um número só, nada muda; com vários, continua pegando o principal até
  a etapa 2 escolher o número da conversa.
- Webhook: a conversa criada/atualizada por mensagem recebida na API oficial
  grava `whatsapp_config_id` = o número que recebeu.
- `template-webhook.ts`: vários números na mesma WABA são a mesma conta —
  aceitar N linhas se todas forem da mesma conta.

### Etapa 2 — envio, caixa de entrada e configuração

(A tela de configuração subiu da etapa 3 para cá: sem ela não há como
cadastrar o segundo número para testar.)

- `lib/whatsapp/official-number.ts` → `loadOfficialNumber(db, accountId,
  conversationId?)`: o número da conversa (`whatsapp_config_id`, conferido
  contra a conta) ou o principal. Usado no envio manual / API pública
  (`send-message.ts`), automações (`automations/meta-send.ts`), fluxos e IA
  (`flows/meta-send.ts` → `loadAccountMetaCredentials(…, conversationId)`,
  inclusive o "digitando…"), e reações.
- Caixa de entrada: com 2+ números oficiais, cada um tem etiqueta e entrada
  no filtro de canal (`official:<id>`); com 1, segue "API oficial".
- Migration **113**: `whatsapp_config.display_phone_number` (gravado ao salvar
  e no teste de conexão) e `set_primary_whatsapp_number(uuid)` (troca o
  principal numa transação, SECURITY INVOKER).
- API: `/api/whatsapp/config` aceita `?id=` (GET/DELETE) e `config_id` /
  `add: true` / `label` (POST); recusa o mesmo número duas vezes na conta
  (`number_already_added`) e remover o principal enquanto houver outros
  (`primary_has_others`). `/api/whatsapp/numbers`: GET lista, PATCH
  principal / nome. `verify-registration` aceita `?id=`.
- Configurações → WhatsApp (`components/settings/official-numbers.tsx`):
  lista de números (nome, telefone, principal, status), "Adicionar número",
  "Tornar principal"; o formulário existente edita o número escolhido e
  ganhou o campo "Nome do número". Sem número algum, a tela é a de antes.
- Ainda não: roteamento de responsáveis por número oficial
  (`specs/channel-routing-responsibles.md`) — fica para a etapa 3.

### Etapa 2b — uma conversa por (contato, número) e IA por número

Decidido com o dono do produto em 2026-10-08, após o teste com dois números.

- Migration **114**: o índice único de conversas passa de (conta, contato)
  para (conta, contato, número) — número = `coalesce(whatsapp_channel_id,
  whatsapp_config_id)`. Vale para oficiais e WAHA. Conversas existentes
  ficam como estão.
- `lib/whatsapp/conversation-number.ts` (`findConversationOnNumber`,
  `defaultNumber`, `numberColumns`) é o único find-or-create de conversa:
  webhook oficial, webhook WAHA, disparos (`broadcast-record`), prospecção,
  API pública/MCP (`resolve-conversation`, número principal) e envio a um
  contato pelo CRM (conversa mais recente; sem nenhuma, o principal). Uma
  conversa oficial anterior à 114 sem número é adotada pelo número que a
  procurar.
- A conversa não troca mais de número: o webhook só procura/cria a do
  número que recebeu.
- Automações: sem conversa no contexto (gatilho de etiqueta/agenda), usam a
  conversa mais recente do contato (o `.maybeSingle()` antigo quebraria com
  duas). "Atribuir" e "fechar conversa" agem na conversa do gatilho; sem
  ela, em todas as do contato.
- IA por número oficial: `ai_channel_agents.whatsapp_config_id`; a ligação
  antiga "API oficial" migrou para o número principal. `loadChannelAgentId`
  recebe o número; a tela de Agentes lista um slot por número oficial
  (`cfg:<id>`). Roteadores continuam por "API oficial" como um todo.
- Autor nas mensagens: `messages.ai_agent_id` (gravado nos envios da IA).
  No contexto da resposta automática, mensagens da empresa que o agente não
  escreveu vêm marcadas — "[enviada por um atendente humano]", "[enviada
  pelo agente "X"]", "[enviada por uma automação]" — com uma linha no
  prompt explicando as marcas, para o agente manter seu papel.
- Pendente: a ficha do contato listar as conversas por número (hoje os
  atalhos "abrir conversa" levam à mais recente).

### Etapa 3 — implementada (2026-10-08)

- Limite por plano: ver Open questions (migration 116).
- Disparos (migration **117**, `broadcasts.whatsapp_config_id`): com 2+
  números oficiais, o assistente (passo 4) mostra "Enviar pelo número";
  `/api/whatsapp/broadcast`, agendados e retomadas (`broadcast-resume`) usam
  esse número, e o registro na conversa vai para a conversa dele.
- Responsáveis por número oficial (migration **118**):
  `channel_routing_policies.whatsapp_config_id`; a regra antiga "API
  oficial" migrou para o principal; `routing_policy_for()` resolve a regra
  de uma conversa (canal WAHA → número oficial/principal → regra legada) e é
  usado pelo trigger de atribuição, pela notificação de conversa sem dono
  (`notification_team_for_number`) e no app (`routingPolicyIdFor`,
  `eligibleAssigneesFromMap` com o número). A tela de responsáveis lista um
  item por número oficial (`cfg:<id>`).
- Ficha do contato: `ContactConversations` lista uma conversa por número,
  com link para a caixa de entrada.
- Pendente: roteadores de IA por número oficial (hoje valem para "API
  oficial" como um todo).

### Etapa 3 — plano original

- Roteamento de responsáveis por número oficial.
- Disparos: escolher o número (ou rodízio, reaproveitando
  `specs/broadcast-channel-rotation.md`).
- Modelos: sincronizar por WABA (números da mesma WABA compartilham modelos).
- Limite de números oficiais por plano (`lib/billing/plans`).

## Acceptance criteria

Etapa 1:
- [ ] Migration 112 aplica do zero no CI e `verify-schema.sql` confere o
      índice parcial, as colunas novas e a ausência do UNIQUE(account_id).
- [ ] Uma conta com um número continua funcionando igual (envio, recebimento,
      modelos, disparos, configurações).
- [ ] Mensagem recebida na API oficial grava `conversations.whatsapp_config_id`.
- [ ] Conversas oficiais existentes ficam com `whatsapp_config_id` preenchido.
- [ ] Um segundo número inserido direto no banco (is_primary = false) recebe
      mensagens na conta certa, e as leituras de "o número da conta" não quebram.

Etapa 2 e 3: a detalhar ao começar cada uma.

## Risks / open questions

- ~~Preço/pacotes~~ — decidido em 2026-10-08: os planos padrão (Essencial,
  Profissional, Escala) incluem **1 número** de WhatsApp, oficial OU por QR;
  mais números só no plano **sob medida**. Migration **116**:
  `accounts.max_whatsapp_numbers` (NULL = padrão: 1; ilimitado se a conta é
  `exempt`), definido pela plataforma no painel de Assinantes
  (`set_number_limit`). `lib/billing/number-limit.ts` conta oficiais + WAHA
  e é checado ao ADICIONAR um número em `/api/whatsapp/config` e
  `/api/whatsapp/waha/channels` (código `number_limit`). Landing atualizada
  (1 número em todos os planos; "vários números" no sob medida).
- ~~Modelos entre WABAs diferentes~~ — migration **119**: `message_templates.waba_id`
  (NOT NULL DEFAULT ''), unicidade (account_id, waba_id, name, language) no
  lugar do antigo (user_id, name, language). A sincronização lê TODAS as
  WABAs dos números da conta (token de cada uma); linhas antigas sem WABA são
  adotadas pela WABA do principal. A submissão grava a WABA do principal. O
  assistente de disparo só oferece números da WABA do modelo. Ainda não: criar
  modelo escolhendo a WABA (hoje cria na do principal).
- Alerta de conexão (banner da caixa de entrada): lista cada número oficial
  desconectado pelo nome quando há mais de um.
- **Teste real:** validar etapa 2 exige um segundo número registrado na Meta.
- **Conversa que muda de número:** se o cliente escreve para o número B numa
  conversa que estava no A, a conversa passa para o B (último número que o
  cliente usou). Alternativa seria fixar no primeiro; decidido assim por ser
  o comportamento do WAHA e o esperado pelo cliente final.
