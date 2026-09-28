# PRD: melhorias no wacrm inspiradas no DeskcommCRM

> Documento de planejamento, não uma spec de implementação. Cada item priorizado
> abaixo que avançar vira sua própria spec em `specs/` (ver `specs/TEMPLATE.md`)
> antes de qualquer código.
>
> **Rastreio de status** (o que já foi implementado vs. o que ainda é
> só spec): [`status-melhorias-deskcomm.md`](status-melhorias-deskcomm.md).

## Contexto

O `wacrm` (fork de `ArnasDon/wacrm`) e o `DeskcommCRM` (fork de
`melgarafael/DeskcommCRM`) são dois produtos de CRM de WhatsApp com propósitos
distintos, mantidos pelo mesmo operador:

- **wacrm**: SaaS hospedado (Vercel + Supabase), multi-conta, com Flows/automações,
  broadcasts, templates Meta oficiais, dashboard, app mobile e API pública já
  maduros — visto pelo volume de branches `feat/*` no upstream.
- **DeskcommCRM**: produto self-host, distribuído como imagem Docker para VPS de
  cliente, multi-tenant com RLS desde o dia 1, com doutrina pesada de
  compliance (LGPD), auditoria e white-label — porque quem instala é o próprio
  cliente final, não uma equipe interna.

Essa diferença de modelo de distribuição é a origem da maioria dos gaps abaixo:
o DeskcommCRM foi forçado a resolver problemas de "instalação em produção de
terceiro, sem supervisão" que o wacrm, rodando numa Vercel controlada pelo
operador, nunca precisou encarar — mas alguns desses problemas (auditoria,
anti-banimento) valem para QUALQUER produto de WhatsApp, hospedado ou não.

## Como este documento foi produzido

Comparação de código, não de marketing: grep nos dois repositórios pelas
áreas abaixo, confirmando presença/ausência antes de listar como gap. Medido
em 2026-09-28.

## Oportunidades, em ordem de prioridade

### P0 — Log de auditoria estruturado e protegido contra adulteração — ✅ implementado em 2026-09-28

**Gap confirmado**: `wacrm` não tem uma tabela de auditoria — mutações (quem
criou/editou/excluiu o quê) não deixam rastro pesquisável. O DeskcommCRM tem
`api_audit_log`, alimentado em toda mutação POST/PATCH/DELETE bem-sucedida, com
uma garantia dura: nem `service_role` tem `UPDATE`/`DELETE`/`TRUNCATE` na tabela
via PostgREST — só o dono do banco. Ou seja, mesmo uma chave de serviço vazada
não apaga o rastro.

**Por que importa pro wacrm**: é multi-conta com convite de membros, papéis
(admin/agent), broadcasts em massa e automações que mandam mensagem sozinhas —
todas ações que, sem trilha auditável, tornam qualquer investigação de "quem
mandou isso"/"quem apagou aquele contato" impossível depois do fato. Sem
contar o valor comercial: "log de auditoria" é item de checklist em toda venda
B2B de porte médio.

**Ver spec**: [`specs/audit-log-endurecido.md`](../specs/audit-log-endurecido.md)

### P0 — Anti-banimento no canal WAHA (throttle + opt-out no envio manual) — ✅ implementado em 2026-09-28

**Gap confirmado (revisado)**: a detecção de opt-out em si **já existe** no
wacrm (migration 053, `src/lib/contacts/opt-out.ts`, com a mesma regra dupla
do DeskcommCRM contra falso positivo — "tem como parar a dor?" não marca opt-
out, "para de me mandar mensagem" marca), e já bloqueia automações e
broadcast. O gap real é: (1) nenhum throttle de envio na integração WAHA —
mensagem sai sem espaçamento mínimo entre chamadas; (2) o envio manual
(resposta de agente no inbox) não checa `opted_out_at` antes de mandar, então
um humano ainda consegue mandar pra quem já pediu pra parar.

**Por que importa pro wacrm**: WAHA é WhatsApp não-oficial — a conta do
cliente final é quem paga o preço de um banimento, e "mandei mensagem pra
quem pediu pra parar" é o motivo nº 1 de denúncia em massa que detona um
número. Isso é risco de produto direto, não só qualidade de código.

**Ver spec**: [`specs/waha-anti-banimento-e-opt-out.md`](../specs/waha-anti-banimento-e-opt-out.md)

### P2 — White-label / marca por conta

**Gap confirmado**: `wacrm` tem uma marca fixa; não há resolução de marca por
conta/organização (nome, logo, cor de acento). O DeskcommCRM resolve isso do
banco (`platform_branding` / `organizations.settings.branding`), nunca de
env var, justamente porque uma imagem só serve todo revendedor.

**Por que é P2**: só faz sentido se o wacrm for vendido por agências/revendas
que precisam apresentar como marca própria para o cliente final delas — outra
pergunta de produto antes de spec. Se a resposta for sim, vale nota: o
DeskcommCRM aprendeu na prática que "nunca `NEXT_PUBLIC_*` para marca, nunca
`public/favicon.ico` fixo" evita rebuild por cliente — um atalho que vale
replicar de cara, não descobrir de novo.

### P2 — Extensões declarativas em vez de fork por cliente

**Gap confirmado**: não há mecanismo de extensão no wacrm — customização por
cliente hoje seria branch/fork. O DeskcommCRM resolveu isso com um sistema de
extensões declarativas (a organização ativa uma capacidade nomeada; instalar
não concede acesso a código nem tabela).

**Por que é P2**: é infraestrutura pesada de construir (schema de capacidades,
runtime de ativação, tela de administração) — só compensa se o wacrm já tiver
o problema concreto de "vários clientes pedindo o mesmo tipo de customização
de nicho" acontecendo hoje. Vale revisitar quando (e se) esse padrão aparecer
nos pedidos de clientes, não antes.

## O que NÃO está nesta lista (e por quê)

- **RLS / multi-tenancy**: já grepado — `wacrm` também usa Postgres RLS via
  Supabase; não há gap estrutural aqui, os dois produtos partem do mesmo
  princípio.
- **Funcionalidades de produto** (Flows, broadcasts, templates Meta, IA):
  o wacrm já está à frente do DeskcommCRM nessas áreas — o fluxo de
  aprendizado aqui vai na direção contrária, não é escopo deste documento.

## Próximos passos

1. Revisar as duas specs P0 (`audit-log-endurecido.md`,
   `waha-anti-banimento-e-opt-out.md` — a segunda já implementada) e decidir
   se a primeira entra no backlog.
2. Para os P2 (white-label, extensões): validar com dados reais de
   clientes/pedidos antes de transformar em spec — são apostas de modelo de
   negócio, não conserto de lacuna técnica.
