# Spec: Agenda (agendamento com cliente)

Substitui a nota `agenda-exploratory.md`. Decisões tomadas com o usuário:

- **Agendamento com cliente** (consulta/reunião/visita ligada a um
  contato), não agenda interna de turnos.
- **Sem sincronização externa** na v1 (nada de Google Calendar/OAuth).
- **Escopo completo**: calendário + lembrete + nó de Flow que oferece
  horários livres e agenda sozinho.

## Modelo de dados (migration 058)

`appointment_settings` — uma linha por conta (horário de atendimento):

| coluna | tipo | padrão |
|---|---|---|
| `account_id` | uuid PK → accounts | |
| `timezone` | text (IANA) | `America/Sao_Paulo` |
| `work_days` | int[] (0 = domingo) | `{1,2,3,4,5}` |
| `day_start` / `day_end` | time | `09:00` / `18:00` |
| `slot_minutes` | int (5–480) | `30` |
| `reminder_enabled` | bool | `true` |
| `reminder_hours_before` | int (1–168) | `24` |
| `reminder_text` | text | mensagem padrão com `{{data}}`/`{{hora}}` |

`appointments`:

- `contact_id` (obrigatório), `conversation_id` (opcional), `assigned_to`
  (agente, opcional — `NULL` = agenda compartilhada da conta).
- `starts_at` / `ends_at` (`timestamptz`, `ends_at > starts_at`).
- `status`: `scheduled | confirmed | completed | cancelled | no_show`.
- `source`: `manual | flow`; `flow_run_id` quando veio do bot.
- `reminder_sent_at` — marca o lembrete enviado (idempotência do cron).

**Conflito**: constraint de exclusão (`btree_gist`) impede dois
compromissos não cancelados sobrepostos para o mesmo agente (ou para a
agenda compartilhada, quando `assigned_to` é nulo). É o que resolve a
corrida de dois clientes tocando no mesmo horário ao mesmo tempo — o
segundo `INSERT` falha com `23P01` e o bot oferece horários de novo.

RLS: leitura para qualquer membro, escrita para `agent+`; configurações
só `admin+`. Mesmo padrão do resto do schema.

## Fases

1. **Base** — migration, `lib/appointments/` (geração de horários livres
   pura e testada, conversão de fuso sem dependência nova), API
   `/api/appointments` (CRUD) e `/api/appointments/settings`, página
   `/agenda` com visão de semana e mês, criação/edição em diálogo, item
   "Agenda" na sidebar.
2. **Lembretes** — `GET /api/appointments/cron` (mesmo segredo
   `AUTOMATION_CRON_SECRET`, aceita header ou bearer), envia o
   `reminder_text` X horas antes pela conversa do contato.
3. **Nó de Flow `offer_slots`** — calcula os próximos horários livres,
   manda uma lista interativa (até 10 linhas, limite da Meta), e quando
   o cliente toca num horário cria o compromisso e segue para
   `next_node_key`. Sem horários → `no_slots_next_node_key`. Grava
   `{{vars.agendamento}}` com a data/hora legível para as mensagens
   seguintes.

## Limitações conhecidas

- **Janela de 24h do WhatsApp**: o lembrete é mensagem de texto livre.
  Se o cliente não falou nas últimas 24h, a Meta recusa; o cron registra
  a falha e não tenta de novo. Lembrete fora da janela exigiria template
  aprovado — fica para depois.
- Canais WAHA enviam pelo mesmo `sendMessageToConversation`, então o
  lembrete segue o canal da conversa.
- Sem arrastar para reagendar na v1 — edição pelo diálogo.
- Feriados/exceções de dia não existem na v1 (só dias da semana fixos).
