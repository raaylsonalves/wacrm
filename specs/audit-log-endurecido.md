# Spec: log de auditoria endurecido

**Status (2026-09-30): implemented (migration 065, `src/lib/audit.ts`); operator actions also write to it (migrations 090–092).**

## Problem

Nenhuma mutação relevante (criar/editar/excluir contato, disparar broadcast,
mudar papel de membro, conectar/desconectar canal WAHA) deixa rastro
pesquisável hoje. Se algo acontece — um contato some, um broadcast sai errado,
um membro perde acesso — não há como responder "quem fez isso e quando" sem
vasculhar logs de aplicação genéricos (se existirem, e por tempo limitado).

Isso é tanto risco operacional (investigar incidente) quanto lacuna comercial
(clientes B2B de porte médio pedem "log de auditoria" em due diligence).

Referência: o DeskcommCRM resolve isso com `api_audit_log`
(`CLAUDE.md`, seção "Audit log"), com uma garantia dura — nem `service_role`
tem `UPDATE`/`DELETE`/`TRUNCATE` na tabela via PostgREST, só o dono do banco.

## Non-goals

- Não é um sistema de observabilidade/APM (isso é Sentry/logs de
  infraestrutura, já cobertos separadamente).
- Não cobre leituras (GET) — só mutações com efeito (POST/PATCH/DELETE que
  alteraram algo).
- Não inclui UI de visualização nesta primeira spec — o objetivo inicial é
  a tabela existir e ser alimentada corretamente; a tela de "Atividade" pode
  ser spec separada depois que houver dado real para mostrar.
- Não cobre retenção/expurgo automático nesta spec — abrir como follow-up
  quando o volume justificar (o DeskcommCRM só precisou disso depois de medir
  uso real em produção).

## Current behavior

Não há tabela de auditoria em `wacrm`. Mutações passam por rotas em
`src/app/api/**/route.ts` (padrão já mapeado nesta sessão em
`src/app/api/whatsapp/waha/channels/route.ts` e vizinhos) e por Server
Actions, sem nenhum ponto central que registre o evento.

## Proposed change

1. **Nova tabela `audit_log`** (migration Supabase), mínimo necessário:
   - `id uuid primary key default gen_random_uuid()`
   - `account_id uuid not null references accounts(id)`
   - `actor_user_id uuid references auth.users(id)` (null para ações de
     sistema/cron)
   - `action text not null` (ex.: `channel.created`, `channel.deleted`,
     `contact.anonymized`, `broadcast.sent`, `member.role_changed`)
   - `resource_type text not null`, `resource_id uuid`
   - `metadata jsonb not null default '{}'` — nunca token/segredo/corpo de
     mensagem, só o que descreve a mutação (ex.: `{ "old_role": "agent",
     "new_role": "admin" }`)
   - `request_id uuid`, `created_at timestamptz not null default now()`
   - índice em `(account_id, created_at desc)` para a futura tela de
     atividade

2. **RLS**: select restrito a membros da própria `account_id` (mesma política
   de isolamento que as demais tabelas já usam). Sem policy de
   `update`/`delete` para `authenticated` nem `anon` — só o INSERT tem
   policy.

3. **Endurecimento contra a service_role** (o ponto que dá valor real à
   tabela): revogar `UPDATE`, `DELETE` e `TRUNCATE` de `anon`, `authenticated`
   E `service_role` explicitamente via `REVOKE`, depois do `GRANT` default do
   Supabase — replicar o raciocínio de `CLAUDE.md` (migration 0258 do
   DeskcommCRM): o default ACL de tabelas novas em `public` concede tudo a
   esses três papéis, e um `GRANT` enumerado só ACRESCENTA, nunca retira. Sem
   o `REVOKE` explícito, uma chave de serviço vazada consegue apagar seu
   próprio rastro.

4. **Helper `audit()`** (`src/lib/audit.ts`), fire-and-forget (não bloqueia a
   resposta da rota, não derruba a mutação principal se a escrita de log
   falhar — só loga erro pro Sentry), chamado nos pontos de mutação
   prioritários:
   - `POST/DELETE /api/whatsapp/waha/channels` e `[id]`
   - mudança de papel de membro (`account_id` compartilhado)
   - `POST /api/whatsapp/broadcast`
   - `contacts/[id]/anonymize`

5. **Escopo desta primeira spec**: cobrir só esses pontos de alto risco
   acima, não toda rota de mutação do produto — expandir depois que o padrão
   estiver validado em produção.

## Acceptance criteria

- [ ] Migration cria `audit_log` com RLS que impede leitura cross-account
- [ ] `service_role` NÃO tem `UPDATE`/`DELETE`/`TRUNCATE` em `audit_log`
      (conferir via `information_schema.role_table_grants`, igual ao comando
      que `CLAUDE.md` do DeskcommCRM documenta)
- [ ] Criar/excluir canal WAHA grava uma linha em `audit_log`
- [ ] Mudar papel de membro grava uma linha com `old_role`/`new_role`
- [ ] Enviar broadcast grava uma linha (sem o corpo da mensagem em claro)
- [ ] Anonimizar contato grava uma linha
- [ ] Falha ao gravar audit NÃO derruba a mutação principal (testar
      simulando erro no insert)

## Risks / open questions

- Qual o volume esperado? Se broadcasts em massa gerarem uma linha por
  destinatário (em vez de uma por disparo), o volume pode ser desproporcional
  — decidir se o evento é "broadcast disparado" (1 linha) ou "mensagem
  enviada" (N linhas) antes de implementar. Recomendo 1 linha por disparo
  nesta primeira versão.
- Retenção: sem expurgo automático, a tabela cresce indefinidamente. Aceitável
  para o volume inicial, mas anotar como dívida conhecida (não fingir que
  "nunca vai precisar").
