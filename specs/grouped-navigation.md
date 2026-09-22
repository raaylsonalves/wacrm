# Spec: Navegação agrupada (Atendimento / CRM / Agente de IA / Canais)

> Terceiro dos quatro specs desta rodada. Puramente apresentacional e de
> baixo risco — mas colocado depois de WAHA e multi-agente de propósito:
> agrupar 9 itens em 4 categorias hoje é uma reforma pequena; fazer
> agora e de novo depois que "Canais" e "Roteadores" ganharem telas
> próprias seria retrabalho. Modelo de referência: o deskcomm resolveu
> exatamente esse problema em `docs/superpowers/specs/
> 2026-08-03-navegacao-agrupada-design.md` com um registro único do
> qual sidebar/hub/busca derivam — a ideia central deste spec é portar
> esse padrão, adaptado ao tamanho real do wacrm (bem menor que os "~30
> telas" que motivaram o deskcomm).

## Problem

`src/components/layout/sidebar.tsx` tem um array plano `navItems` com 9
entradas (Dashboard, Inbox, Notificações, Contatos, Funis, Broadcasts,
Automações, Flows, Agentes de IA) — hoje isso ainda cabe numa tela sem
rolar, mas depois dos specs anteriores (`waha-channel-connection.md`,
`multi-agent-router.md`) o wacrm ganha pelo menos mais 2 telas
(Canais/Conexões, Roteadores) e potencialmente uma 3ª (Agenda, ver
`specs/agenda-exploratory.md`). Numa lista plana, "Roteadores" fica com
o mesmo peso visual que "Dashboard" — sem hierarquia, o usuário não tem
como adivinhar que "Roteadores" é uma configuração de IA e não uma tela
de uso diário.

## Non-goals

- **Construir um "hub" por grupo** (uma página de destino tipo grade de
  cards antes de entrar no grupo). O deskcomm precisou disso porque
  tinha grupos com 6+ telas cada; nenhum grupo do wacrm passa de 4-5
  itens mesmo depois dos specs anteriores. Sidebar agrupado com
  cabeçalhos basta.
- **Busca global (⌘K)**. O deskcomm construiu isso na mesma leva porque
  já tinha um `SearchTrigger` morto (`console.info` "not implemented")
  para aproveitar. wacrm não tem esse componente hoje — fica como
  possível follow-up, não parte deste spec.
- **Sistema de permissão por item (`minRole`)**. O sidebar do wacrm já
  não filtra por role hoje (todo item visível a qualquer membro da
  conta, a página guarda por role no server) — manter esse
  comportamento; não introduzir uma segunda fonte de verdade de
  permissão só para o menu.

## Current behavior

`src/components/layout/sidebar.tsx:101-111`:

```ts
const navItems: NavItem[] = [
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/inbox', labelKey: 'inbox', icon: MessageSquare },
  { href: '/notifications', labelKey: 'notifications', icon: Bell },
  { href: '/contacts', labelKey: 'contacts', icon: Users },
  { href: '/pipelines', labelKey: 'pipelines', icon: GitBranch },
  { href: '/broadcasts', labelKey: 'broadcasts', icon: Radio },
  { href: '/automations', labelKey: 'automations', icon: Zap },
  { href: '/flows', labelKey: 'flows', icon: Workflow, beta: true },
  { href: '/agents', labelKey: 'aiAgents', icon: Bot },
];
```

Renderizado por um único `<ul>` (linhas 270-346), sem agrupamento. Uma
`bottomNavItems` separada (só "Settings") fica abaixo de uma linha
divisória — essa parte já É um "grupo" informal, na prática.

## Proposed change

### 1. Estrutura de dados — array de grupos, não registro completo

Diferente do deskcomm (que precisou de um registro compartilhado entre
3 superfícies — sidebar, hub, ⌘K), o wacrm só tem 1 superfície de
navegação hoje. Não vale a complexidade de um registro central com
múltiplas projeções para uma única consumidora. Basta agrupar o array
existente:

```ts
interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  beta?: boolean;
}

interface NavGroup {
  labelKey: string; // cabeçalho do grupo, ex. "navGroupAtendimento"
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    labelKey: 'navGroupAtendimento',
    items: [
      { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
      { href: '/inbox', labelKey: 'inbox', icon: MessageSquare },
      { href: '/notifications', labelKey: 'notifications', icon: Bell },
    ],
  },
  {
    labelKey: 'navGroupCrm',
    items: [
      { href: '/contacts', labelKey: 'contacts', icon: Users },
      { href: '/pipelines', labelKey: 'pipelines', icon: GitBranch },
    ],
  },
  {
    labelKey: 'navGroupAgenteIa',
    items: [
      { href: '/agents', labelKey: 'aiAgents', icon: Bot },
      { href: '/automations', labelKey: 'automations', icon: Zap },
      { href: '/flows', labelKey: 'flows', icon: Workflow, beta: true },
      // + '/agents/routers' quando multi-agent-router.md for implementado
    ],
  },
  {
    labelKey: 'navGroupCanais',
    items: [
      { href: '/broadcasts', labelKey: 'broadcasts', icon: Radio },
      // + '/settings/channels' (ou tela própria) quando
      //   waha-channel-connection.md for implementado
    ],
  },
];
```

Onde colocar Automações/Flows é a decisão menos óbvia — foram
classificados em "Agente de IA" porque, na prática, a maioria dos
fluxos/automações do wacrm dispara IA ou serve de camada de decisão
antes/depois dela. Se o uso real mostrar que a maioria das automações
não envolve IA (ex.: tags, roteamento manual), mover para um grupo
"Automação" próprio é um ajuste de 2 linhas, não uma reestruturação —
esse é o ponto de manter o array simples em vez de um registro pesado.

### 2. Render — cabeçalho de grupo + mesma lista de itens

Trocar o `<ul>` único por um `.map` externo sobre `navGroups`, um
cabeçalho pequeno (`text-[11px] uppercase text-muted-foreground/70`,
escondido quando `collapsed` — igual ao resto do sidebar já esconde
texto no modo rail) antes de cada `<ul>` de itens. O corpo de cada
`<li>` (ativo, badge beta, dot de unread, badge de notificação) não
muda nada — é o mesmo JSX que já existe, só reindentado dentro do loop
de grupos.

### 3. i18n

4 chaves novas em `messages/*.json` sob `Sidebar.*`:
`navGroupAtendimento`, `navGroupCrm`, `navGroupAgenteIa`,
`navGroupCanais` — nos 4 locales (en/pt/es/ko), como qualquer outra
chave do Sidebar hoje. `src/i18n/messages.test.ts` garante a paridade.

### 4. `bottomNavItems` (Settings) fica como está

Não é um grupo temático — é a área de conta/sistema, já visualmente
separada por uma borda. Sem mudança.

## Acceptance criteria

- [ ] O sidebar mostra 4 cabeçalhos de grupo (Atendimento, CRM, Agente
      de IA, Canais) com os itens atuais redistribuídos, sem perder
      nenhuma rota existente.
- [ ] Modo colapsado (rail de ícones) continua funcionando — cabeçalhos
      de grupo escondidos, só ícones, mesmo comportamento de hoje.
- [ ] Badge "beta" do Flows, dot de unread do Inbox e badge de
      notificações continuam funcionando idênticos dentro do novo
      agrupamento.
- [ ] `npm run test:unit` (parity i18n) passa com as 4 chaves novas nos
      4 locales.
- [ ] Nenhuma rota muda de URL — isto é reorganização visual, não
      migração de página.

## Risks / open questions

- **Onde Automações/Flows realmente pertencem** — ver nota no passo 1.
  Vale validar com uso real antes de fechar, não é uma decisão cara de
  reverter (é só onde o item aparece na lista).
- **Ordem dos grupos**: Atendimento primeiro (uso diário mais
  frequente: dashboard + inbox) é a leitura mais natural, espelhando a
  ordem que o próprio usuário citou. Mudar a ordem depois é trivial.
- **Ganhos futuros com WAHA/roteador**: este spec já deixa comentado
  onde os itens novos entram (`Canais` ganha a tela de conexões,
  `Agente de IA` ganha "Roteadores") — implementar aqueles specs deve
  só adicionar uma linha ao array, não reabrir este.
