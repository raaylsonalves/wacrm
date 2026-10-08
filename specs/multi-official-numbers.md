# Spec: Vários números oficiais (Meta Cloud API) por conta

**Status (2026-10-08): etapas 1 e 2 implementadas (migrations 112–113). Etapa 3 pendente.**

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
- **Uma conversa por número.** Continua UMA conversa por (conta, contato)
  (`idx_conversations_account_contact`). A conversa guarda por qual número
  oficial ela está falando; se o cliente escrever para outro número, a
  conversa passa a falar por ele (como o WAHA já faz com `whatsapp_channel_id`).
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

### Etapa 3 — configurações, disparos, plano

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

- **Preço/pacotes:** quantos números oficiais por plano e se número extra é
  vendido à parte — decisão comercial, necessária só na etapa 3.
- **Modelos entre WABAs diferentes:** dois números em WABAs diferentes têm
  modelos separados; a tela de modelos hoje assume uma WABA por conta.
- **Teste real:** validar etapa 2 exige um segundo número registrado na Meta.
- **Conversa que muda de número:** se o cliente escreve para o número B numa
  conversa que estava no A, a conversa passa para o B (último número que o
  cliente usou). Alternativa seria fixar no primeiro; decidido assim por ser
  o comportamento do WAHA e o esperado pelo cliente final.
