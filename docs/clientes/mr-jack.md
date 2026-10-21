# Mr. Jack Barbearia (Aldeota) — configuração e pendências

Situação em 21/10/2026. Sem IDs, telefones ou dados de clientes: este
repositório é público.

## Como está configurado

- **WhatsApp:** número conectado por QR code (WAHA, motor NOWEB) num EC2 da
  AWS sempre ligado. A sessão envia `message.any`, então respostas digitadas
  no celular aparecem no CRM e pausam a IA da conversa.
- **Agenda:** integração ScaLE restrita à unidade Aldeota. A IA consulta,
  agenda, cancela e remarca direto na ScaLE.
- **Horário de funcionamento (cadastro do CRM):** segunda a sábado, 9h às
  20h, America/Fortaleza. É a única fonte do horário — os prompts não
  repetem o horário; a IA recebe a hora atual e se está aberto/fechado.
- **IA "Carla"** (gpt-4o-mini, decidido manter), três agentes:
  - *Recepção e dúvidas* (padrão): serviços, valores, Área VIP, endereço.
  - *Agendamento Barbearia*: horários, agendar/cancelar/remarcar.
  - *Visagismo*: opções Essencial / Estratégico / Premium e objeções.
  - Todos: apresentação da Carla com as próprias palavras, tom espelhando o
    cliente (formal × descontraído), bom humor de barbearia só com cliente
    descontraído, casos para a equipe no que ela não sabe, aviso de fora do
    expediente.
- **Automações:**
  - Boas-vindas para qualquer cliente que chega (12h sem falar).
  - Apresentação da Área VIP pela palavra "vip".
  - Etiqueta Visagismo pelas palavras "visagismo/visagista".
- **Follow-ups (8h às 20h, Fortaleza):**
  - Normal: 1h de silêncio → 8h → 8h (última), com humor quando a conversa
    foi descontraída. Não sai para quem tem agendamento futuro.
  - Visagismo: 20 min, só para contatos com a etiqueta Visagismo.
- **Lembrete de agendamento:** 1h antes do horário, pela conversa do cliente.

## Pendências (em espera)

1. **Feriados e horários especiais** — o CRM não tem cadastro de datas
   fechadas. Aguardando o dono informar o funcionamento em feriados.
   Proposta: datas especiais no CRM (fechado ou horário diferente), a IA
   sabendo dos fechamentos dos próximos 7 dias, follow-ups suspensos nesses
   dias, feriados de Fortaleza e nacionais pré-cadastrados. Até lá: bloquear
   o dia na ScaLE.
2. **Lembrete × cancelamento feito na barbearia** — o lembrete de 1h antes
   usa a cópia do CRM, que não sabe de cancelamentos feitos direto na ScaLE
   (recepção, app, barbeiro). Proposta: conferir na ScaLE antes de enviar e
   sincronizar periodicamente os agendamentos dos clientes por telefone (a
   ScaLE não lista a agenda inteira de uma unidade, só por telefone).
   Decidir também se o lembrete vale para agendamentos feitos na recepção.
3. **Texto da automação da Área VIP** — diz "Você chegou através do nosso
   anúncio" para qualquer pessoa que escreva "vip". Opções: tirar a frase ou
   disparar só para quem veio de anúncio. Também proposto assinar as
   automações como Carla.

## A conferir em conversas reais

- Anúncio clique-para-WhatsApp: se a descrição do anúncio chega completa
  pelo WAHA e se a IA responde sobre ele.
- "Digitando…" aparecendo antes da resposta da Carla.
- Humor nos follow-ups: com gpt-4o-mini aparece em ~metade das mensagens
  descontraídas e às vezes escapa para cliente formal.
