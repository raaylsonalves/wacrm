# Spec: Wizard de onboarding pós-cadastro

> Explorat贸rio/arquitetural, pedido junto com o início da implementação
> de `specs/waha-channel-connection.md` — os dois se cruzam: o passo de
> "conectar WhatsApp" do wizard é a MESMA tela de conexão (Cloud API ou
> WAHA) que aquele spec constrói, só que embutida num fluxo guiado em
> vez de solta em Configurações. Modelo de referência: o wizard do
> deskcomm em `app/onboarding/*` (welcome → connect-whatsapp → setup-ai
> → funil → testar → invite-team → done), com a lição principal dele
> documentada em `lib/onboarding/passos.ts`: **a ordem, os rótulos e o
> resumo final devem vir de UMA lista só**, nunca três que podem
> divergir.

## Problem

Hoje, `signup/page.tsx` cria a conta e — sem token de convite — deixa o
Supabase redirecionar para `/` (raiz do app), que cai direto em
`/dashboard`. Uma conta nova nasce **vazia**: sem canal conectado, sem
agente de IA configurado, sem pipeline (na verdade o pipeline JÁ é
semeado automaticamente — `pipelines/page.tsx`'s `seedDefaultPipeline`
roda no primeiro load —, mas isso é o único passo que já existe hoje).
O usuário cai num dashboard sem dados, sem inbox, sem conversa, e
precisa descobrir por conta própria que existe uma tela de Configurações
com uma aba de WhatsApp, e outra tela `/agents` para a IA.

O deskcomm mediu exatamente esse problema (ver `docs/testing/
user-journey-map.md`, achado citado no `CLAUDE.md`: onboarding e
primeiras ações são "a primeira impressão... bug ali é abandono") e
resolveu com um wizard obrigatório de 6-7 passos antes do primeiro
acesso ao inbox real.

## Non-goals

- **Nuvemshop / integração de loja.** É específico do deskcomm
  (e-commerce); wacrm não tem esse conceito. Passo removido do modelo.
- **Sugestão de pipeline por tipo de negócio.** O deskcomm gera colunas
  de kanban a partir do "o que você vende" (`o_que_faz` no schema).
  wacrm já semeia um pipeline padrão genérico
  (`DEFAULT_STAGE_COLORS`/`defaultStageNames` em `pipelines/page.tsx`) —
  manter esse padrão fixo por agora; personalizar por nicho é um
  follow-up, não faz parte deste wizard.
- **Migrar contas existentes para dentro do wizard.** Só contas criadas
  a partir da entrada em produção deste spec passam pelo wizard. Contas
  já ativas continuam como estão — sem "onboarding retroativo" forçado.
- **Bloquear o acesso ao resto do app durante o wizard.** Ao contrário
  do deskcomm (que redireciona de volta pro wizard até `onboarded_at`
  ser setado), aqui cada passo é pulável desde o primeiro — ver
  "Proposed change" ponto 3. Forçar seria mais atrito que valor para o
  público self-host do wacrm, que inclui gente tecnicamente confortável
  configurando por Configurações direto.

## Current behavior

- `src/app/(auth)/signup/page.tsx`: cria usuário via
  `supabase.auth.signUp`, sem `emailRedirectTo` (exceto no fluxo de
  convite) — cai no destino default do Supabase.
- `017_account_sharing.sql`: um trigger cria a `account` pessoal no
  signup (nome = `full_name`), então toda conta já nasce com
  `account_id` resolvido — não existe uma tela "criar organização"
  separada como no deskcomm (`/get-started`); aqui já existe implícito.
- `pipelines/page.tsx`: já semeia um pipeline default no primeiro load
  vazio (`seedAttempted` ref, guarda contra dupla-semeadura em
  StrictMode) — é o único "onboarding" que já existe, e é silencioso.
- `whatsapp_config`/`ai_configs`: ambos nascem inexistentes até o
  usuário preencher Configurações manualmente — nenhum gatilho leva o
  usuário até lá.
- Nenhuma coluna de estado de onboarding em `accounts` hoje.

## Proposed change

### 1. Estado — uma coluna jsonb em `accounts`, um único array de passos

```sql
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS onboarding_state jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;
```

`onboarding_state` guarda, por passo, `{ done: boolean, skipped?: boolean,
...dados do passo }` — mesma forma que o deskcomm usa. Ex.:
`{ "channel": { "done": true }, "ai": { "done": true, "skipped": false } }`.

Um módulo `src/lib/onboarding/steps.ts`, mesmo padrão de
`lib/onboarding/passos.ts` do deskcomm — **uma lista só**, da qual o
roteador, o indicador de progresso e o resumo final derivam:

```ts
export interface OnboardingStep {
  segment: string;             // /onboarding/<segment>
  labelKey: string;            // i18n
  applies: (ctx: OnboardingContext) => boolean;
  done: (state: OnboardingState) => boolean;
  skipped: (state: OnboardingState) => boolean;
}

export const STEPS: readonly OnboardingStep[] = [
  { segment: 'welcome',  labelKey: 'stepWelcome',  applies: () => true, ... },
  { segment: 'channel',  labelKey: 'stepChannel',  applies: () => true, ... }, // conecta WhatsApp — Cloud API ou WAHA
  { segment: 'ai-agent', labelKey: 'stepAiAgent',  applies: () => true, ... }, // configura o agente de IA (BYO key, prompt)
  { segment: 'test',     labelKey: 'stepTest',     applies: () => true, ... }, // manda uma mensagem de teste, vê o agente responder
  { segment: 'team',     labelKey: 'stepTeam',     applies: () => true, ... }, // convidar membros (pode pular)
] as const;

export function nextStep(state: OnboardingState, ctx: OnboardingContext): OnboardingStep | null {
  return STEPS.filter((s) => s.applies(ctx)).find((s) => !s.done(state)) ?? null;
}
```

`ctx` existe desde já (mesmo com um único fator hoje: nenhuma feature
opcional own/off no wacrm que mude os passos) para não repetir o erro
que o deskcomm teve que corrigir depois (passo fantasma quando uma
integração está desligada) — se/quando `waha-channel-connection.md` ou
`multi-agent-router.md` adicionarem uma escolha ("Cloud API vs. WAHA"),
ela markup aqui, não como um passo a mais.

### 2. Rotas — `src/app/onboarding/*`, fora do `(dashboard)` group

```
src/app/onboarding/
  layout.tsx          — indicador de progresso (Stepper), deriva de STEPS
  page.tsx            — resolve nextStep() e redireciona
  welcome/page.tsx    — nome do negócio (accounts.display_name), fuso horário
  channel/page.tsx    — a MESMA tela de conexão de canal do spec WAHA,
                         embutida (Cloud API ou "Conectar via WAHA")
  ai-agent/page.tsx   — BYO key (OpenAI/Anthropic), prompt inicial,
                         reaproveita o formulário de /agents existente
  test/page.tsx       — envia uma mensagem de teste pro próprio número
                         do usuário (ou simula) e mostra a resposta da IA
                         — a lição do deskcomm ("ver ele atender ANTES de
                         acabar transforma 'configurei um sistema' em
                         'contratei alguém'") vale igual aqui
  team/page.tsx        — reaproveita o formulário de convite de
                         Configurações › Membros
  done/page.tsx        — resumo (feito/pulado por passo), botão "Ir para o Inbox"
```

`page.tsx` da raiz espelha o roteador do deskcomm:

```ts
export default async function OnboardingIndex() {
  const ctx = await requireAccount(); // já existe (getCurrentAccount)
  if (ctx.account.onboarded_at) redirect('/dashboard');
  const step = nextStep(ctx.account.onboarding_state, {});
  redirect(step ? `/onboarding/${step.segment}` : '/onboarding/done');
}
```

### 3. Pulável desde o passo 1 — diferente do deskcomm

Cada tela tem um "Pular por agora" que grava `{ skipped: true }` e avança
— igual ao deskcomm — MAS além disso, um link discreto "Pular onboarding
e ir para o Inbox" fica sempre visível (marca todos os passos restantes
como pulados de uma vez e seta `onboarded_at`). Justificativa no
"Non-goals": o público self-host inclui quem só quer editar
Configurações direto.

### 4. Redirecionamento pós-signup

`signup/page.tsx`: setar `emailRedirectTo` para `/onboarding` também no
caso sem convite (hoje só o caso COM convite seta redirect). Contas
convidadas (`/join/<token>`) continuam pulando o wizard — quem aceita
convite entra numa conta que já existe e já passou (ou não) pelo
onboarding do dono; não faz sentido repetir.

### 5. `done/page.tsx` — resumo, não celebração vazia

Lista os passos, feito/pulado (mesma função `summaryFor(state)` que
alimenta o Stepper), e destaca especificamente o que ficou pendente
("Você pulou: convidar equipe — pode fazer isso depois em
Configurações › Membros"), não só "Tudo pronto!" genérico.

## Acceptance criteria

- [ ] Uma conta nova (sem convite) é redirecionada para `/onboarding`
      logo após confirmar o e-mail.
- [ ] O wizard segue exatamente a ordem de `STEPS`; pular um passo grava
      `skipped: true` e avança; o indicador de progresso reflete os dois
      estados (feito vs. pulado) visualmente diferentes.
- [ ] O passo "channel" conecta um número de verdade (Cloud API ou WAHA,
      dependendo de qual spec estiver implementado) — não é uma tela
      decorativa.
- [ ] O passo "test" só avança depois de uma resposta real da IA
      aparecer na tela (ou o usuário pular explicitamente).
- [ ] `onboarded_at` é setado ao chegar em `/onboarding/done` OU ao usar
      o link "pular onboarding" — os dois caminhos levam ao mesmo estado
      final.
- [ ] Uma conta com `onboarded_at` preenchido nunca é redirecionada para
      `/onboarding` de novo, mesmo se algum passo individual nunca foi
      "done" (ex.: pulou tudo).
- [ ] Convite (`/join/<token>`) continua sem passar pelo wizard.

## Risks / open questions

- **Depende da ordem de implementação dos specs anteriores.** O passo
  "channel" deste wizard fica mais rico depois de
  `waha-channel-connection.md` estar pronto (oferece Cloud API + WAHA),
  mas pode nascer só com Cloud API (o que já existe hoje) e ganhar a
  opção WAHA depois, sem reabrir este spec — só a tela do passo muda.
- **"Test" (passo de ver a IA responder) precisa de infraestrutura de
  teste.** O deskcomm manda pro próprio WhatsApp do usuário; replicar
  isso no wacrm depende do canal já estar `connected` (Cloud API exige
  o número estar verificado; WAHA exige a sessão estar `WORKING`) —
  decidir se um canal "conectando" bloqueia esse passo ou se ele oferece
  um modo simulado (sem enviar de verdade) como fallback.
- **Onde fica o convite de equipe na história?** O deskcomm pede convite
  DEPOIS de testar a IA — replicar essa ordem (convidar por último, não
  primeiro) foi decisão deliberada deles: só faz sentido convidar
  alguém pra um sistema que já demonstrou funcionar. Manter a mesma
  ordem aqui é a recomendação, mas vale confirmar com o usuário.
- **i18n**: todo texto novo entra nos 4 locales (`messages/*.json`) —
  volume razoável (5-6 telas), vale orçar tempo de tradução/revisão
  junto com a implementação, não depois.
