# Spec: Conexão de canais via WAHA (multi-número)

> Explorat贸rio/arquitetural — este é o primeiro dos quatro specs pedidos
> nesta rodada (WAHA → multi-agente/roteador → menu agrupado → agenda),
> nessa ordem porque os demais dependem ou ficam mais simples depois
> deste. Referencia `specs/unofficial-whatsapp-api-provider.md`, que já
> cobria a ideia geral de uma segunda forma de conexão — mas assumindo
> uma biblioteca embarcada (Baileys/whatsapp-web.js) que o próprio wacrm
> teria que rodar. Este spec é mais estreito e mais barato: o usuário já
> tem uma VPS rodando **WAHA** (`docs/runbooks/waha-hostgator.md` no
> deskcomm é a referência operacional), então o processo de longa duração
> já existe fora do wacrm — o trabalho aqui é só o cliente HTTP + webhook.

## Problem

wacrm só conecta um número por conta, e só via Meta Cloud API:

- `whatsapp_config` tem `UNIQUE(account_id)` (migration 017, linha 326) —
  **uma conta só pode ter UM número**, ponto.
- O webhook (`src/app/api/whatsapp/webhook/route.ts`) resolve a conta por
  `metadata.phone_number_id` — específico do payload da Meta.
- `src/lib/whatsapp/meta-api.ts` é importado por **17 arquivos** — todo
  envio (`send-message.ts`, `broadcast-core.ts`, `flows/meta-send.ts`,
  `automations/meta-send.ts`) chama a Graph API diretamente, sem
  abstração.

Isso trava dois pedidos reais do usuário: (1) conectar via WAHA, que ele
já tem hospedado, sem depender de verificação de negócio da Meta; e (2)
múltiplos números por conta — hoje impossível mesmo trocando o provedor,
porque a trava é o `UNIQUE(account_id)`, não a Meta.

## Non-goals

- **Substituir a Cloud API.** Ela continua sendo o caminho "oficial" e
  recomendado; WAHA é uma alternativa por canal, não uma migração.
- **Rodar o próprio Baileys/whatsapp-web.js.** WAHA já é esse processo.
  wacrm fala HTTP com ele — sem container novo, sem gerenciar sessão de
  WebSocket, sem Chromium. Isso simplifica o ponto 4 do spec anterior
  (que exigia um processo long-running dentro do próprio deploy do
  wacrm) a quase nada: só precisamos de uma URL + API key do WAHA do
  usuário.
- **Descobrir/gerenciar a VPS do WAHA.** Fora de escopo — o usuário
  informa `base_url` + `api_key` de uma instância WAHA que ele já
  administra (poderia ser HostGator, Railway, qualquer VPS com Docker).
- **Paridade total de recursos.** WAHA (engine NOWEB) não tem templates
  aprovados pela Meta, nem preço por conversa, nem catálogo de produtos.
  Enviar texto, mídia e reagir a mensagens primeiro; interativos
  (botões/listas) depois, como capacidade separada por canal.
- **Múltiplos números via Cloud API.** A Cloud API continua 1:1 por
  conta nesta primeira fase — o `UNIQUE(account_id)` sai só para contas
  que adotam WAHA. (Ver "Risks" sobre revisitar isso depois.)

## Current behavior

- `whatsapp_config`: uma linha por conta, colunas moldadas pela Cloud
  API (`phone_number_id`, `waba_id`, `access_token`, `verify_token`).
  `UNIQUE(account_id)` impede uma segunda linha.
- Webhook: HMAC-SHA256 contra `META_APP_SECRET`, resolve
  `metadata.phone_number_id` → `whatsapp_config` → conta (migration
  013's índice único). Todo o pipeline pós-resolução (dedupe de
  contato, resolver conversa, persistir mensagem, mirror de mídia,
  fan-out para Flows/automations/IA/webhooks) já está numa função só,
  chamada depois da resolução — é reaproveitável.
- Envio: cada chamador (`send-message.ts`, `broadcast-core.ts`,
  `flows/meta-send.ts`, `automations/meta-send.ts`) importa
  `meta-api.ts` direto e monta o payload da Graph API.
- Configuração: `src/app/api/whatsapp/config/route.ts` faz
  `verifyPhoneNumber` → `registerPhoneNumber` → `subscribeWabaToApp`,
  específico da Cloud API; a UI é um formulário (token, phone_number_id,
  etc.), não um QR code.

## Proposed change

### 1. Esquema: canais como tabela filha, não mais 1 config por conta

Substituir o `UNIQUE(account_id)` de `whatsapp_config` por uma tabela
`whatsapp_channels` (nome provisório) com `account_id` **não-único**:

```sql
CREATE TABLE whatsapp_channels (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('cloud_api', 'waha')),
  label text,                          -- "Vendas", "Suporte" — como o usuário chama esse número
  status text NOT NULL DEFAULT 'disconnected',
  -- Cloud API only (NULL para linhas 'waha')
  phone_number_id text,
  waba_id text,
  access_token text,                   -- AES-256-GCM, como hoje
  verify_token text,
  -- WAHA only (NULL para linhas 'cloud_api')
  waha_base_url text,
  waha_api_key text,                   -- AES-256-GCM
  waha_session_name text,              -- nome da sessão dentro do WAHA (1 sessão = 1 número)
  connected_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX idx_whatsapp_channels_phone_number_id
  ON whatsapp_channels (phone_number_id) WHERE phone_number_id IS NOT NULL;
CREATE UNIQUE INDEX idx_whatsapp_channels_waha_session
  ON whatsapp_channels (waha_base_url, waha_session_name) WHERE waha_session_name IS NOT NULL;
```

Migrar a linha existente de `whatsapp_config` (1 por conta) para a nova
tabela como `provider = 'cloud_api'`. Toda tabela que hoje referencia
"o número da conta" implicitamente (nenhuma tem FK — o número é
resolvido só no fluxo de envio/webhook) passa a precisar saber **qual**
canal usar quando a conta tem mais de um — ver ponto 4.

### 2. Interface de provedor — igual ao spec anterior, implementação mais simples

Mesma ideia do spec de API não-oficial: uma interface
`WhatsAppProvider` (`sendText`, `sendMedia`, `react`, `onInboundEvent`)
com `CloudApiProvider` (refactor puro do que existe) e um novo
`WahaProvider`. A diferença é que `WahaProvider` é **um cliente HTTP
fino** contra a API do WAHA — sem processo próprio, sem estado de sessão
do lado do wacrm:

- Enviar texto: `POST {base_url}/api/sendText` com `session`, `chatId`,
  `text`, header `X-Api-Key`.
- Enviar mídia: `POST {base_url}/api/sendImage` /
  `/sendFile` (upload já mirrorado no Storage, igual hoje — URL pública,
  não base64, conforme a doutrina de mídia do próprio WAHA).
- Status da sessão: `GET {base_url}/api/sessions/{session}` — usado no
  polling da tela de conexão (ver ponto 3).

### 3. Fluxo de conexão — QR code, sem tela de formulário Meta

Nova aba em Configurações (ou já dentro da tela de Canais do menu
agrupado — ver `specs/grouped-navigation.md`):

1. Usuário escolhe "Conectar via WAHA".
2. Formulário simples: URL base do WAHA + API key da instância (não por
   número — é a chave da instância WAHA inteira) + rótulo do número
   ("Vendas", "Suporte 2").
3. Backend chama `POST {base_url}/api/sessions` para criar uma sessão
   nova (nome gerado, ex. `wacrm-{channel_id}`), pede o QR
   (`GET /api/{session}/auth/qr`) e devolve a imagem para a tela.
4. Front faz polling (ou Supabase Realtime, se preferir empurrar o
   status por um webhook do WAHA → nossa API → broadcast) em
   `GET /api/sessions/{session}` até `status = 'WORKING'`.
5. Grava `waha_session_name`, `status = 'connected'`, `connected_at`.

### 4. Resolver "qual canal" no envio e no webhook

- **Webhook**: WAHA manda `session` no payload do evento
  (`event: 'message'`, `session: 'wacrm-...'`) em vez de
  `metadata.phone_number_id`. Nova rota
  `POST /api/whatsapp/webhook/waha` (ou um branch dentro da existente,
  decidindo pelo shape do payload) resolve `whatsapp_channels` por
  `waha_session_name` e entra no MESMO pipeline pós-resolução que o
  webhook da Cloud API já usa hoje (extrair essa função compartilhada é
  pré-requisito, igual o spec anterior já apontava).
- **Envio**: toda função que hoje pega "o config da conta" (`send-
  message.ts` etc.) passa a receber/resolver um `channel_id` explícito.
  Quando a conta tem só 1 canal (o caso comum, hoje), resolve
  implicitamente por `account_id` — nenhuma tela nova obrigatória para
  quem não usa multi-número. Quando tem mais de um, quem decide qual
  canal usar em cada contexto:
  - **Inbound**: o canal que recebeu a mensagem (webhook já sabe).
  - **Outbound manual** (inbox, broadcast): `contacts` precisa saber
    por qual canal falou com esse contato pela última vez — adicionar
    `conversations.channel_id` (nullable, preenchido no primeiro
    inbound/outbound) em vez de tentar adivinhar por conta a cada envio.

### 5. Migração de dados

- Uma migration move a linha única de `whatsapp_config` (se existir)
  para `whatsapp_channels` com `provider = 'cloud_api'`.
- `conversations.channel_id` começa `NULL` e é populado lazy — não
  precisa de backfill em lote, já que toda conta hoje tem exatamente 1
  canal (o próprio) até que WAHA seja adicionado.

## Acceptance criteria

- [ ] Uma conta pode ter 1 canal Cloud API + N canais WAHA
      simultaneamente (ou N canais WAHA sem Cloud API nenhum).
- [ ] Conectar um número WAHA é: colar URL + API key da instância,
      escanear QR, ver "Conectado" — sem tocar em Meta for Developers.
- [ ] Uma mensagem inbound por um canal WAHA aparece no MESMO inbox,
      MESMA tabela `conversations`/`messages`, passando pelo MESMO
      fan-out (Flows → automations → IA → webhooks) que uma mensagem
      Cloud API.
- [ ] Enviar por um canal WAHA funciona do inbox, de broadcast, de
      automação e de Flow — sem diferença de configuração para quem
      edita a automação/fluxo (o canal é resolvido por conversa, não
      escolhido manualmente em cada passo).
- [ ] Uma conta com só Cloud API não vê nenhuma tela nova nem precisa
      migrar nada — comportamento idêntico ao de hoje.

## Risks / open questions

- **`X-Api-Key` do WAHA é da instância inteira, não por sessão** — se
  vazar, todas as sessões daquela VPS ficam expostas, não só uma. Vale
  documentar isso claramente na tela de conexão (mesma criticidade que
  já tratamos para `ENCRYPTION_KEY`).
- **WAHA/NOWEB ainda é WhatsApp não-oficial** — mesmo risco de
  banimento do spec anterior; a mesma exigência de aviso explícito na
  UI se aplica aqui.
- **Sessão cai (`FAILED`/desconectada) sem o usuário notar.** Precisa de
  um cron ou webhook de status do WAHA que marque o canal como
  `disconnected` e dispare um aviso (`agent_inbox_items` ou notificação
  in-app) — sem isso, mensagens saindo por um canal morto falham
  silenciosamente.
- **Cloud API também virar multi-número?** Este spec deixa isso de
  fora (non-goal), mas a tabela `whatsapp_channels` já comporta —
  bastaria remover a restrição de "1 Cloud API por conta" depois, sem
  reabrir o esquema. Decidir se vale a pena quando aparecer demanda real.
- **Reaproveitar o cliente WAHA para o multi-agente/roteador**: o spec
  de roteador (`specs/multi-agent-router.md`) assume que uma conversa
  já sabe seu `channel_id` — dependência direta deste spec.
