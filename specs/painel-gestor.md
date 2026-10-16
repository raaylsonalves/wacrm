# Painel do gestor (outubro/2026)

Protótipo aprovado: https://claude.ai/artifact/SWrNGqjwNvMYhbE8hzJQQB

Telas: Visão geral, Equipe, Atendimento, celular, hub em cards e sala estilo Habbo.

## Problema

O app é centrado em uma pessoa atendendo. O dono que contrata o CRM e coloca
funcionários para atender não tem como acompanhar o que cada um está fazendo.
O Painel e o Atendimento se misturam: números soltos, sem ação ligada, e o gráfico
de tempo médio da primeira resposta não diz nada ao gestor.

## Decisão

Um Painel único, organizado em abas. Cada aba responde a uma pergunta.

| Aba | Pergunta | Quem vê |
|---|---|---|
| Visão geral | O que está acontecendo agora? | admin+ |
| Equipe | O que cada pessoa fez no período? | admin+ |
| Atendimento | Como está indo o negócio? (o relatório atual de `/analytics`) | admin+ |
| Minha fila | O que é meu para fazer? | todos; é a aba padrão do atendente |

## Fases

1. **Painel em abas e visão do gestor** (em andamento):
   - **Visão geral:**
     - esperando agora;
     - atendimentos e leads de hoje, com comparação;
     - "Equipe agora", com presença, abertas, esperando, resposta de hoje e
       resolvidas;
     - "Precisa de atenção": esperando acima da meta, sem responsável e
       passadas pela IA;
     - agenda de hoje.
   - **Equipe:** tabela de desempenho por pessoa (conversas, resposta típica,
     % na meta, sem resposta, negócios ganhos e valor, agendamentos).
   - **Atendimento:** o relatório atual, como aba.
   - **Minha fila:** o foco do dia atual.
   - **Banco:** RPCs SECURITY INVOKER (RLS do chamador): `team_live`,
     `team_performance` e `attention_items` (migration 133).
2. **Origem do lead e motivo de perda:**
   - **Origem:** guardar o `referral` que a Meta envia nos anúncios
     Click-to-WhatsApp. "Campanha" quando o lead veio de um disparo. Link com
     código para o site e a bio. O resto vira "direto", editável.
   - **Motivo de perda:** obrigatório ao marcar o negócio como perdido, com uma
     lista por segmento editável pelo dono. Automático quando o follow-up esgota
     sem resposta ("parou de responder"). Sugestão da IA a partir da conversa.
3. **Perfis de segmento:** blocos, nomes ("Negócio" → "Proposta" no crédito),
   funil e motivos de perda padrão por segmento.
4. **Metas e linha do tempo:**
   - meta de vendas e agendamentos por pessoa e por dia;
   - linha do tempo por pessoa, a partir de `deal_events`, das mensagens e das
     atribuições;
   - horas online, que exigem histórico de presença; hoje só existe o "agora".
5. **Hub ao vivo (TV) e sala estilo Habbo:** depois das fases 1, 2 e 4, que
   fornecem os dados. A sala de produção precisa de sprites desenhados (pixel
   art moderno).

## Papéis

O atendente vê só a sua fila e o seu desempenho. Admin e dono veem tudo,
seguindo `lib/auth/roles.ts`.
