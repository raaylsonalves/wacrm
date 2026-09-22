# Nota exploratória: Agenda

> Não é um spec completo — a pedido, é só um registro do que existe,
> do que não existe, e do tamanho real do trabalho, para decidir DEPOIS
> se vale abrir um spec de verdade. Quarto e último item desta rodada.

## O que existe hoje

Nada equivalente no deskcomm (procurei "agenda", "calendar",
"appointment", "scheduling" nos docs dele e não achei nenhuma feature
de calendário/agendamento — não é algo para "trazer de lá", seria
greenfield nos dois produtos). No wacrm, o que já existe e é adjacente:

- `deals.expected_close_date` — uma data solta por negócio, sem
  conceito de compromisso/horário.
- `automations` tem um trigger de `schedule` (execução programada), mas
  é "disparar uma automação numa data", não "marcar um horário com um
  contato".
- Nenhuma tabela de eventos/compromissos, nenhuma UI de calendário,
  nenhuma integração com Google Calendar/CalDAV.

## Por que "Agenda" é maior do que parece

Uma agenda de atendimento de verdade (o caso de uso provável: agendar
consulta/reunião/visita a partir de uma conversa do WhatsApp) puxa pelo
menos:

1. **Schema novo**: `appointments` (contato, agente responsável, início/
   fim, status, canal de origem) — tenant-scoped como tudo mais,
   RLS igual ao resto.
2. **UI de calendário** — não existe nenhum componente de calendário no
   design system atual (`components.json`/shadcn); seria a primeira
   tela do tipo, com view mensal/semanal/dia, drag para reagendar.
3. **Conflito de horário** — bloquear/avisar duplo agendamento por
   agente, fuso horário por conta (`i18n`/`NEXT_PUBLIC_APP_LOCALE` hoje
   é só idioma, não fuso).
4. **Gatilho de conversa → agendamento**: um Flow/automação precisaria
   de um step novo tipo "Oferecer horários" (ler disponibilidade,
   mandar lista interativa, confirmar) — isso é o trabalho mais
   parecido com o que já existe (`SendListStepConfig` em Flows), mas
   ainda é um step novo do zero.
5. **Lembretes** — reaproveitaria o padrão de cron do wacrm
   (`automation_pending_executions`/`GET /api/automations/cron`), mas
   precisa de lógica própria de "X horas antes do compromisso".
6. **Sincronização externa** (Google Calendar etc.) — se for pedido,
   é OAuth + webhook de calendário externo, escopo bem maior que tudo
   acima.

## Recomendação

Não abrir como PRD ainda. Antes de desenhar schema, decidir com o
usuário:

- É **agendamento com o cliente** (reunião/consulta marcada pela
  conversa) ou **agenda interna do agente** (bloqueios de horário,
  turnos)? São produtos bem diferentes — o primeiro é CRM-adjacente
  (perto de `deals`/`contacts`), o segundo é mais RH/operacional.
- Precisa de sincronização com calendário externo no dia 1, ou uma
  agenda só-do-wacrm já resolve?
- Isso é núcleo (todo fork ganha) ou seria melhor como **extensão**
  (padrão que já vimos no deskcomm — pacote declarativo, não PR no
  núcleo) já que nem todo negócio que usa o wacrm precisa de
  agendamento (uma loja de e-commerce não; uma clínica sim)?

Essas três respostas mudam o desenho inteiro — vale uma conversa antes
de qualquer spec.
