# Cliente Agius Promotora: segmento de crédito (anotações, 12/10/2026)

Status: **anotações para estruturar depois.** Nada daqui está implementado.
A Agius é o cliente-piloto em negociação (contrato e implantação). No CRM, a
conta "Agius Promotora" já existe.

## 1. Sobre a Agius

Fonte: site http://corretoraagius.com.br/ (consultado em 12/10/2026).

- **Quem é:** correspondente bancário autorizado, não é banco. Fica em
  **Fortaleza (CE)** e atua desde 2022.
- **Diferenciais que anuncia:**
  - atendimento 100% online, com simulação em menos de 2 minutos;
  - "sem papelada";
  - consultoria para comparar taxas;
  - sigilo dos dados, seguindo as normas do Banco Central.
- **Produtos no site:**
  - empréstimo consignado;
  - cartão de crédito consignado;
  - antecipação do FGTS;
  - empréstimo na conta de energia;
  - no menu também aparecem empréstimo para empresas, automotivo, no cartão
    de crédito e pessoal online.
  - O site não diz explicitamente se o consignado é INSS, servidor ou CLT,
    nem se fazem portabilidade. **Confirmar com eles.**
- **Bancos parceiros:** Itaú, C6 Bank, Banco do Brasil, Daycoval, PicPay,
  Paulista, Fintech Corban, CBA Caixa, Safra, BMG, ICRED, Banrisul, Facta,
  Presença Bank, Digio, NBC Bank, PAN, Vctex, Happy Consig, Qualibanking e BRB.
- **Canais:** WhatsApp, 0800 000 5159, atendimento@corretoraagius.com.br e
  Instagram.
- **Observação:** o site não tem um aviso "nunca pedimos senha". Vale sugerir
  para o site e para as mensagens.

### A perguntar para a Agius

- Quais produtos vendem de fato e qual o peso de cada um (INSS, servidor, CLT,
  FGTS, conta de energia…).
- Quantos vendedores ou atendentes têm, e como dividem os leads hoje.
- De onde vêm os leads: anúncio no WhatsApp, Instagram, listas, indicação.
- Que sistema de digitação ou esteira de propostas usam, e se ele tem API.
- Como calculam e pagam a comissão: por banco, por produto, por vendedor.
- Quais regras de abordagem seguem (convênio, "não me perturbe", restrições de
  contato ativo com aposentados e pensionistas).

### Situação da conta no CRM (12/10/2026)

- A assinatura está **isenta**.
- Módulos liberados: caixa de entrada, contatos, agenda e configurações.
  Agentes, funil e disparos estão **desligados**.
- Tem 2 agentes de IA no Gemini Flash-Lite: o padrão está inativo e há outro
  ativo.
- Para a demonstração: ligar o funil e os agentes e aplicar o pacote de
  crédito (seção 4).

## 2. Como funciona uma promotora de crédito

1. Os leads chegam em volume, quase sempre por anúncio no WhatsApp ou por lista.
2. Qualificação rápida:
   - INSS, servidor, CLT ou FGTS?
   - benefício e margem;
   - já tem empréstimo (portabilidade ou refinanciamento)?
3. Simulação, depois coleta de documentos (RG/CNH, comprovante de residência,
   extrato do benefício), depois digitação da proposta no sistema do banco.
4. Acompanhamento da proposta (em análise → pendência → aprovada → paga) e
   comissão por vendedor e por banco.

## 3. O que o CRM já atende

| Necessidade | Recurso atual |
|---|---|
| Responder muitos leads rápido | IA qualifica 24h e passa para o vendedor com o histórico. No teste do cliente robô, o roteiro de crédito custou ~R$ 0,01 por atendimento (`pricing-costs.md`, 7.1) |
| Áudio de clientes idosos | Transcrição automática; a IA entende o áudio |
| Dados do cliente | Campos personalizados no contato (CPF, tipo de benefício, banco, margem) |
| Etapas da proposta | Funil: Lead → Qualificado → Documentos → Digitado → Pendência → Pago |
| Documentos | Fotos e PDFs ficam salvos na conversa |
| Cliente que some no meio | Follow-up automático |
| Equipe | Distribuição entre vendedores e relatório de Atendimento por pessoa |
| Campanhas | Disparos pela API oficial e prospecção por planilha |
| Segurança | O prompt do agente de crédito já diz "não pedimos senha nem código" |

## 4. O que acrescentar para o segmento

### Prioridade para fechar o contrato

1. **Checklist de documentos por negócio**, com status por item (RG,
   comprovante, extrato). A IA pede o que falta e o follow-up cobra. É o maior
   gargalo de uma promotora.
2. **Aviso automático de status da proposta ao cliente.** Quando o negócio
   muda para "Aprovada" ou "Paga", o cliente recebe a atualização no WhatsApp.
   Reduz o "e aí, saiu?".
3. **Comissão por vendedor e por banco** no relatório de vendas: valor do
   contrato, banco e percentual.
4. **Pacote pronto "Correspondente de crédito":** agente com as regras de
   consignado, funil com as etapas acima, campos (CPF, benefício, banco,
   margem) e mensagens de follow-up. Serve para a Agius e vira produto para
   outras promotoras.

### Conformidade (confirmar com a Agius)

- **Golpes:** a IA nunca pede senha nem código, e há uma mensagem padrão "a
  Agius nunca pede senha".
- **Restrições de contato ativo** com aposentados e pensionistas, e as listas de
  "não me perturbe" do consignado. Isso afeta disparos e prospecção. Usar a API
  oficial (não QR) nas campanhas e respeitar o opt-out, que o CRM já registra.
- **LGPD:** CPF e dados de benefício são sensíveis. Avaliar mascarar o CPF na
  listagem e restringir por papel.

### Depois do piloto

- Simulador com as tabelas de taxa dos bancos que eles operam, configurável
  pela própria Agius.
- Integração com o sistema de digitação, se ele tiver API.

### Ordem sugerida

1. Pacote "Correspondente de crédito" aplicado na conta Agius.
2. Checklist de documentos.
3. Aviso de status ao cliente.
4. Comissão no relatório de vendas.

Com os itens 1 e 2 já dá para uma demonstração forte.

## 5. Contexto geral do produto (12/10/2026)

Lacunas gerais levantadas para o público amplo (vendas, marketing, clínicas,
gestão de equipe). A ser estruturado junto com este documento.

- **Alta prioridade:**
  - tarefas e atividades do vendedor;
  - relatório de vendas (conversão por etapa, valor por vendedor, motivo de
    perda, previsão);
  - metas por vendedor;
  - pacotes prontos por segmento.
- **Média prioridade:**
  - catálogo e orçamento;
  - cobrança Pix dentro da conversa;
  - Instagram Direct;
  - teste grátis guiado.
- **Recomendação:** lançar com 2 segmentos fortes. Crédito (Agius) e
  clínicas/estética são bons candidatos.
