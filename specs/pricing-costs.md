# Custos, margem e hospedagem (outubro/2026)

Status: **planejado, para o futuro.** Nada daqui está implementado. Hoje a
produção roda em Vercel + Supabase free, com clientes de teste.

Este documento junta três decisões ainda abertas:

1. se os preços dos planos cobrem os custos;
2. se a IA passa a ser fornecida pela Nordia (gerenciada) em vez de cada cliente
   colocar sua própria chave;
3. a migração do app para uma VPS da Hostinger.

Os números de IA foram **medidos** no `ai_usage_log` em 10/10/2026.
Os de preço de modelo são **tabela pública dos provedores, dólar a R$ 5,50**.
Revisar antes de decidir.

---

## 1. Custo da IA (medido)

Amostra: 86 chamadas em 11 conversas, de 18/09 a 10/10/2026. Ainda é pequena,
então refazer a consulta com clientes reais (SQL no fim do documento).

| Por chamada | Média |
|---|---|
| Tokens de entrada (prompt, histórico, base de conhecimento) | ~2.500 (~35% em cache no GPT-4o-mini) |
| Tokens de saída | ~50 |
| Chamadas por conversa | mediana 8, média 14, máximo 47 |

| Modelo | Por conversa | 1.000 conv./mês | 5.000 conv./mês |
|---|---|---|---|
| Gemini Flash-Lite | ~R$ 0,02 | ~R$ 20 | ~R$ 100 |
| GPT-4o-mini | ~R$ 0,03 | ~R$ 27 | ~R$ 135 |
| Modelo "top" (GPT-4o, Claude Sonnet) | ~R$ 0,50 | ~R$ 530 | ~R$ 2.650 |

Áudio transcrito custa ~R$ 0,02/min. Os embeddings da base de conhecimento são
desprezíveis.

**Leitura:** com modelo leve, a IA custa centavos por conversa. O risco é o
**modelo caro**, que custa cerca de 20 vezes mais. Uma conta Essencial com modelo
top e 1.000 conversas por mês dá prejuízo.

## 2. Custos fixos

| Item | Hoje | Planejado |
|---|---|---|
| App | Vercel (Hobby, teste) | VPS Hostinger **KVM 4**, R$ 1.500 por 2 anos, **~R$ 62/mês** |
| Banco, auth, storage | Supabase free | **Supabase Pro, US$ 25 (~R$ 140/mês)** |
| E-mail | Resend free (3 mil por mês) | igual, até passar da cota |
| Mensagens WhatsApp | cobradas pela Meta direto na conta do cliente | igual |
| **Total fixo** | — | **~R$ 200/mês** |

Custos que variam com a receita:

- **Mercado Pago:** ~1% no Pix, ~5% no cartão.
- **Impostos:** Simples Nacional entre ~6% e 15%, conforme o anexo e o fator R.
  **Confirmar com o contador.**

### Por que o Supabase sai do free antes do primeiro cliente pagante

- Os limites são de 500 MB de banco e 1 GB de storage. A mídia do WhatsApp
  (áudios, fotos) enche isso rápido.
- Não há backup diário.
- O projeto é pausado quando fica inativo.
- A máquina é pequena e a fila de conexões também. Em 10/10/2026 o PostgREST
  travou o pool por cerca de 1h20 e o app inteiro ficou vazio. O aviso de
  instabilidade e o `/api/health` vieram desse incidente.

### Por que não hospedar o Supabase na VPS (por enquanto)

- O self-host do Supabase são cerca de 10 containers: Postgres, PostgREST, GoTrue,
  Realtime, Storage, Kong, Studio etc.
- Ele consome de 4 a 8 GB de RAM.
- Backup, atualização de segurança e restauração passam a ser responsabilidade
  nossa.
- A economia seria de ~R$ 140 por mês. Não compensa o risco operacional nesta fase.
  Reavaliar quando houver receita e alguém dedicado a infraestrutura.

## 3. Margem por cliente (Essencial, R$ 197)

Cenário: IA gerenciada com modelo leve, entre 1.000 e 3.000 conversas com IA por
mês.

| | 5 clientes | 10 clientes | 30 clientes |
|---|---|---|---|
| Fatia do custo fixo | R$ 40 | R$ 20 | R$ 7 |
| Impostos (~10%), Mercado Pago e IA | R$ 55–125 | R$ 55–125 | R$ 55–125 |
| **Sobra por cliente** | **R$ 30–100** | **R$ 50–120** | **R$ 65–135** |

O custo fixo se paga a partir de cerca de 2 clientes. Daí em diante, quem decide
a margem é a IA.

## 4. Decisões propostas

### 4.1 IA inclusa em todo plano (decidido em 10/10/2026)

O produto é "atendimento com IA no WhatsApp". Um plano sem IA viraria só mais
um CRM de inbox, disputando por preço. Por isso **todo plano inclui IA**, e os
planos se diferenciam pela cota e pelos recursos.

Hoje o cliente precisa criar uma chave na OpenAI, cadastrar um cartão em dólar e
configurar tudo. A IA inclusa elimina esse atrito, que trava a venda para
clínicas e imobiliárias.

**Unidade vendida: "atendimento com IA".** Um atendimento é um contato atendido
pela IA dentro de uma janela de 24 h, na mesma lógica da conversa da Meta.

- O custo real é em tokens, mas token não serve para vender: o cliente não
  entende a unidade e não consegue prever o gasto.
- Pelas medições, 1 atendimento tem de 8 a 14 respostas da IA, cada resposta
  usa ~2.500 tokens, e o custo fica entre R$ 0,02 e R$ 0,05 com modelo leve.
- Por dentro, há uma **trava em tokens por atendimento**. Ela impede que um caso
  anormal estoure o custo: um robô do outro lado (o caso da Claro) ou uma
  conversa de horas.

| Plano | Atendimentos com IA/mês | Agentes | Custo de IA no pior caso |
|---|---|---|---|
| Essencial | 500 | 1 | ~R$ 15–25 |
| Profissional | 2.000 | 5 + roteador | ~R$ 60–100 |
| Escala | 6.000 | ilimitados | ~R$ 180–300 |

As cotas são um ponto de partida e devem ser ajustadas com o uso real dos
primeiros clientes. No teste ou na demonstração, a cota é pequena (~50).

**Modelo:** fixo e leve, com a chave da Nordia guardada em variável de ambiente
e nunca exposta ao cliente. Ver a seção 6 sobre a descontinuação de modelos.

**"Use sua própria chave":** opção avançada do Escala. Nesse caso não há cota,
porque o custo é do cliente, e ele pode usar modelos top.

**Ao atingir a cota:**

1. Com 80% da cota, o dono recebe aviso no painel, por e-mail e por WhatsApp.
2. Com 100%, a IA pausa e as conversas vão para a fila da equipe, de modo que
   nenhum cliente fica sem resposta. Aparece o botão "Comprar mais
   atendimentos".
3. **Pacote pré-pago avulso**, no Pix ou no cartão, reaproveitando os Pix
   avulsos (Orders) que já existem. Sugestão: +1.000 atendimentos por R$ 49.
   O custo é de ~R$ 30–50, e a Octadesk cobra ~R$ 0,35 por crédito, então há
   espaço para subir. Falta decidir se o pacote vale só até o fim do mês ou se
   acumula.
4. Mais para frente, **recarga automática** opcional no cartão.

O excedente **não** vai somado na mensalidade seguinte. A assinatura recorrente
do Mercado Pago tem valor fixo, e somar o excedente seria a "surpresa na
fatura" que a landing critica nos concorrentes.

**Painel interno de custo por cliente**, só para os operadores da plataforma:
atendimentos, tokens e R$ estimados no mês, por conta, comparados ao valor do
plano.

Isso fecha o item aberto "teto mensal de gasto com IA" em `review-2026-10.md`.

### 4.2 Taxa de implantação

- **R$ 497 a R$ 997** pela implantação assistida: agentes, fluxos, funil e
  treinamento. A RD Station cobra R$ 1.999 ou mais.
- **Isenta no plano anual**, para empurrar o cliente ao compromisso maior.
- Sem taxa para quem configura sozinho.
- A tabela comparativa da landing não promete "sem taxa de implantação", então
  não há conflito.

### 4.3 Número extra

Ainda aberto: preço (a pesquisa sugere R$ 97–147 por mês) e limite por plano.
Ver `market-research-2026-10.md`, seção 5, item 3.

## 5. Migração para a VPS (Hostinger KVM 4)

KVM 4: 4 vCPU, 16 GB de RAM, 200 GB NVMe. Folga de sobra para o app e o WAHA. A
VPS **não** hospeda o banco.

### O que já existe

- `next.config.ts` com `output: "standalone"`, além do `Dockerfile` e do
  `docker-compose.yml` (ver `docs/docker.md`).
- Rota `GET /api/health`, usada pelo healthcheck do container e pelo monitor de
  uptime.

### O que falta fazer

1. **Proxy reverso com HTTPS:** Caddy no compose, com certificado automático para
   `crm.nordiatech.com.br`. O DNS segue na Vercel e passa a apontar o registro A
   para o IP da VPS.
2. **WAHA no mesmo compose**, com volume persistente para as sessões e acessível
   só pela rede interna. A URL do WAHA nas configurações passa a ser a interna.
3. **Agendadores.** Trocar o cron-job.org por cron do sistema, ou por um
   container que chama, a cada 1–5 minutos e com o header `x-cron-secret`:
   - `/api/automations/cron`
   - `/api/flows/cron`
   - `/api/appointments/cron`

   Conferir também a varredura de cobrança (`lib/billing/sweep.ts`): de onde ela
   é disparada hoje e passar para o mesmo agendador.
4. **Deploy:** GitHub Actions gera a imagem e envia para o GHCR; na VPS,
   `docker compose pull && up -d`. Variáveis `NEXT_PUBLIC_*` entram no build e
   segredos ficam só no `.env` da VPS.
5. **`after()` e `maxDuration`:** no Node standalone não existe o limite de 300 s
   da Vercel, então o processamento do webhook roda até o fim. Conferir que
   nenhum código depende de `@vercel/*` em tempo de execução
   (`@vercel/analytics` é só no cliente e pode sair).
6. **Segurança da VPS:**
   - SSH só por chave;
   - firewall liberando apenas 22, 80 e 443;
   - `unattended-upgrades`;
   - usuário sem root para o Docker.
7. **Observabilidade:**
   - logs do container com rotação;
   - monitor de uptime externo em `/api/health`;
   - alerta de disco acima de 80%.
8. **Corte:**
   1. subir em paralelo num subdomínio de teste;
   2. reapontar o webhook da Meta e o do Mercado Pago só depois de validar;
   3. baixar o TTL do DNS um dia antes;
   4. manter a Vercel ativa por uma semana como volta rápida.

### Ordem sugerida (antes do primeiro cliente pagante)

1. Supabase Pro.
2. Migração para a VPS, seguindo a lista acima.
3. Limpar as sobras de teste da cobrança: a assinatura de R$ 1, as linhas de
   sandbox e a `MERCADOPAGO_SANDBOX`.
4. IA gerenciada com cota, painel de custo e taxa de implantação.

---

## 6. Descontinuação de modelos da OpenAI

Situação levantada em 10/10/2026. Confirmar sempre na página oficial:
https://developers.openai.com/api/docs/deprecations

| Uso no código | Modelo | Desligamento | Substituto indicado |
|---|---|---|---|
| Resposta em áudio (`lib/ai/voice-reply.ts`) | `gpt-4o-mini-tts` | **06/01/2027** | `gpt-realtime-2.1-mini` |
| Transcrição de áudio (`lib/ai/transcribe.ts`) | `gpt-4o-mini-transcribe` | **26/02/2027** | `gpt-transcribe` / `gpt-live-transcribe` |
| Chat (`lib/ai/models.ts`) | `gpt-4o-mini`, `gpt-4o` | sem data anunciada na API da OpenAI (o Azure tem 2027) | — |

**Ações:**

- Trocar o TTS e a transcrição antes de dezembro de 2026, conferindo o preço
  dos substitutos.
- Ter um modelo de chat padrão que não seja de uma geração antiga: o
  `gpt-5.4-mini`, que já está na lista, ou o Gemini Flash-Lite.
- Na IA inclusa, o modelo fica sob controle da Nordia. Uma troca vira mudança
  de configuração e não exige que cada cliente reconfigure nada.

## 7. Simulação por tipo de negócio e planos de entrada (10/10/2026)

O pedido é atender empresas pequenas, com caixa curto, por meio de planos de
entrada de **R$ 50, R$ 80 e R$ 100**.

Simulador interativo (Monte Carlo com 2.000 meses por cenário, calibrado com o
`ai_usage_log`): https://claude.ai/artifact/WG39Ym2NYTQbq5xmxTxomw

**Premissas da tabela:**

- GPT-4o-mini;
- imposto de 10% e Mercado Pago de 3%;
- custo fixo de R$ 200 dividido entre 20 clientes (R$ 10 por cliente);
- coluna "IA, mês forte" é o percentil 90: 9 em cada 10 meses custam menos que
  isso.

| Perfil | Atendimentos com IA/mês | IA, mês típico | IA, mês forte (p90) | Sobra no plano de R$ 50 | Sobra no plano de R$ 80 |
|---|---|---|---|---|---|
| Autônomo | ~130 | R$ 2,30 | R$ 2,70 | R$ 31 | R$ 57 |
| Loja de bairro | ~530 | R$ 7,30 | R$ 7,80 | R$ 26 | R$ 52 |
| Clínica pequena | ~300 | R$ 5,50 | R$ 6,10 | R$ 27 | R$ 53 |
| Imobiliária pequena | ~290 | R$ 7,20 | R$ 8,00 | R$ 26 | R$ 52 |
| Correspondente de crédito | ~530 | R$ 13,10 | R$ 14,10 | R$ 19 | R$ 46 |

**Leitura:**

- Com modelo leve, **a IA não é o que inviabiliza um plano de R$ 50**. Mesmo o
  perfil mais pesado gasta cerca de R$ 14 de IA.
- No plano barato, o que pesa é a **fatia do custo fixo**, que depende de quantos
  clientes dividem a conta, e o **tempo de suporte e de implantação**, que não
  entra nessa conta.
- O plano de entrada precisa de **cota** (por exemplo, 300 atendimentos com IA),
  de **modelo leve fixo** e de **implantação self-service**: o cliente usa os
  modelos prontos por segmento, sem horas da Nordia.

**Limites da simulação:**

- A amostra real ainda é pequena (86 chamadas).
- Um cliente com prompt ou base de conhecimento muito grande pode dobrar os
  tokens por resposta.
- A validação de verdade é o painel de custo por cliente (seção 4.1) rodando nos
  primeiros clientes reais. Antes disso, dá para fazer um teste de carga com um
  "cliente robô" simulado contra um agente real, que custa centavos.

### 7.1 Teste real com "cliente robô" (10/10/2026)

O script `scripts/ai-load-test.ts` simula um cliente com um roteiro fixo de
mensagens por segmento. Ele conversa com a IA pelo mesmo caminho da produção:
prompt de auto-resposta, base de conhecimento e provedor da conta.

- Não grava no banco e não envia nada pelo WhatsApp.
- Rodou 3 vezes por cenário, com GPT-4o-mini, totalizando 136 respostas.
- Custo do teste: menos de US$ 0,10.

| Cenário | Respostas por atendimento | Tokens de entrada por resposta | Custo por atendimento |
|---|---|---|---|
| Agente real da Nordia (prompt de 8,4 mil caracteres + base de conhecimento) | 8 | ~3.000 | ~R$ 0,021 |
| Autônomo (manicure) | 5–7 (passou para humano ao agendar) | ~1.170 | ~R$ 0,006 |
| Loja de bairro | 6 | ~1.210 | ~R$ 0,007 |
| Clínica pequena | 7–9 (passou para humano ao agendar) | ~1.240 | ~R$ 0,009 |
| Imobiliária pequena | 10 | ~1.270 | ~R$ 0,012 |
| Correspondente de crédito | 7–9 | ~1.220 | ~R$ 0,010 |

A saída ficou entre ~25 e 50 tokens por resposta, como na medição de produção.

**Conclusões:**

- **O tamanho do prompt e da base de conhecimento é o que mais pesa.** O agente
  real, com prompt longo e base de conhecimento, usa ~3.000 tokens por resposta.
  Um negócio pequeno com prompt objetivo usa ~1.200.
- **O simulador (2.000–3.200 tokens por resposta) é conservador.** Para prompts
  enxutos, o custo real fica cerca de metade do que ele mostra. Ainda assim,
  vale manter essa margem, porque na produção entram as ferramentas da agenda e
  dos contatos (algumas centenas de tokens) e o histórico de conversas reais
  tende a ser maior que o roteiro.
- Custo real de IA para os perfis pequenos: **~R$ 1 a R$ 6 por mês**. No plano
  de R$ 50, a IA não é o problema.
- **Nos modelos prontos por segmento, manter o prompt enxuto (~2–4 mil
  caracteres)** é a principal alavanca de custo. Um limite de tamanho do prompt
  e da base de conhecimento por plano é uma trava mais simples que a cota em
  tokens.

Para rodar de novo:
`npx tsx --env-file=.env.local scripts/ai-load-test.ts <account_id> [runs]`

## 8. Supabase na própria VPS (self-host): conta e gatilho (11/10/2026)

**É possível.** Tudo o que o app usa existe na versão open source em Docker:
Postgres com pgvector, Auth (GoTrue, com SMTP do Resend), PostgREST, Realtime
(inbox ao vivo), Storage (mídia do WhatsApp) e as RPCs e políticas de RLS das
migrations. A KVM 4 (16 GB) comporta o Supabase (~4–6 GB) junto com o app e
o WAHA.

**Economia direta:** o Supabase Pro custa US$ 25/mês, ~R$ 140/mês ou ~R$ 3.400
em 2 anos. Com crescimento, o gerenciado sobe:

- compute maior: +US$ 15 a 60/mês;
- storage acima de 100 GB: ~US$ 0,02/GB;
- egress (tráfego de saída).

Já o self-host fica fixo até a VPS lotar. Com dezenas de clientes, a economia
pode chegar a ~R$ 300–500/mês.

**O que se perde, ou passa a ser trabalho nosso:**

- **Backup e restauração.** É o ponto crítico: se a VPS morrer sem backup fora
  dela, perdem-se todas as contas. É preciso dump diário do Postgres e cópia do
  storage para fora (Cloudflare R2 ou Backblaze, ~R$ 10–30/mês), além de um
  teste de restauração periódico.
- **Atualizações de segurança** do Postgres e dos serviços, feitas à mão.
- **Monitoramento e incidentes.** Uma queda como a de 10/10 vira
  responsabilidade nossa, sem suporte da Supabase.
- **Ferramentas:** sem o painel gerenciado, sem PITR (voltar no tempo), sem
  branches e sem a integração de gerenciamento (MCP) usada para migrations e
  diagnóstico.
- **Um único ponto de falha.** App, banco e WAHA ficam na mesma máquina.

**Migração (quando for a hora):**

1. `pg_dump` / `pg_restore` dos schemas `public`, `auth` e `storage`.
2. Copiar os arquivos dos buckets.
3. Gerar novas chaves (JWT secret, anon e service role) e atualizar o `.env`.
   As senhas dos usuários são mantidas, porque os hashes ficam no schema
   `auth`.
4. Reapontar as variáveis `NEXT_PUBLIC_SUPABASE_*` e fazer o rebuild.

**Decisão sugerida:** começar com o Supabase Pro e migrar para self-host
quando acontecer um destes gatilhos:

- a fatura do Supabase passar de ~US$ 75/mês;
- o backup externo já estiver automatizado e com restauração testada;
- houver alguém para cuidar da infraestrutura.

## 9. Estrutura de planos proposta (11/10/2026)

Rascunho para validar. **Os preços são proposta, não decisão.**

### Princípios

1. **Usuários ilimitados em todos os planos.** O custo marginal de um login é
   quase zero. O que limita os planos é número de WhatsApp, atendimentos com IA
   e volume de disparos.
2. **O tipo de conexão separa os planos de entrada dos demais:**
   - **QR code (WAHA)**, nos planos mais baratos. Não tem custo da Meta nem
     homologação, e liga em minutos. Por outro lado, **é um uso não oficial do
     WhatsApp e tem risco de bloqueio do número.** Serve para **pouco tráfego**:
     atendimento de quem chama, com volume baixo e sem disparos em massa.
   - **API oficial da Meta**, nos planos para escala, com disparos e campanhas.
     Não há risco de bloqueio por uso não oficial, a Meta cobra os modelos
     direto na conta do cliente e há limites de envio oficiais.
3. **A IA vem inclusa em todos os planos por padrão.** Para quem não quer IA,
   existe a **versão "sem IA", mais barata.** O desconto deve ser moderado: a IA
   nos custa só R$ 1–15 por mês com prompt enxuto (seção 7.1), então a versão
   sem IA é questão de valor percebido e de acessibilidade, não de custo.
   Isso ajusta a decisão 4.1: a IA continua sendo o padrão e o argumento de
   venda, e a versão sem IA é uma opção.
5. **Qualquer plano pode usar a própria IA (chave própria).** Quem cadastra a
   própria chave (OpenAI, Anthropic, Gemini ou OpenRouter) paga o preço da
   coluna "sem IA inclusa" e usa a IA **sem cota de atendimentos**, com
   qualquer modelo, porque o custo é dele. Isso já funciona hoje.
   - A coluna "Sem IA" vira **"Sem IA inclusa"**: atende tanto quem não quer
     IA quanto quem traz a própria chave.
   - Os recursos de IA do plano continuam valendo com a chave própria: número
     de agentes, roteador e follow-up.
   - Trava de abuso mesmo com chave própria: o limite de respostas por
     atendimento (40) e a detecção de robô continuam ativos, porque protegem a
     reputação do número e não o nosso custo.
   - Suporte: problemas na conta do provedor (saldo, limite, chave revogada)
     são do cliente. O CRM avisa quando a chave falha (`provider_failure` já
     passa a conversa para humano).
4. **Preço sem pegadinha:** sem "promoção nos 12 primeiros meses" e sem âncora
   falsa. É o argumento contra o WeSales e companhia (pesquisa de mercado,
   seção 1.1).

### Escada proposta

| Plano | Conexão | Com IA inclusa | Sem IA inclusa (sem IA ou chave própria) | Atendimentos com IA inclusa/mês | Disparos |
|---|---|---|---|---|---|
| **Start** | 1 número por QR | R$ 97 | R$ 67 | 300 | não, só atendimento |
| **Essencial** | 1 número, QR ou API oficial | R$ 197 | R$ 147 | 1.000 | sim, na API oficial |
| **Profissional** | até 3 números (API ou QR) | R$ 397 | R$ 317 | 3.000 | sim, com follow-up e roteador |
| **Escala** | números sob medida | R$ 797 | R$ 697 | 8.000 | sim, com API, webhooks e MCP |

Em todos os planos:

- usuários ilimitados;
- contatos ilimitados;
- funil, agenda, automações e relatório de atendimento;
- sem fidelidade.

Pontos a definir:

- Os planos de **R$ 50/80**, citados em 10/10, cabem como Start sem IA (R$ 67)
  ou como um "Start Lite" ainda mais limitado. Validar no simulador.
- Pacote extra de atendimentos com IA (seção 4.1): +1.000 por R$ 49.
- Número extra (seção 4.3).
- Se a versão sem IA pode ligar a IA depois, pagando a diferença no ciclo
  seguinte.
- Como mostrar a escolha na assinatura: "IA inclusa (recomendado)" ou "Usar
  minha própria chave / sem IA".

### Como comunicar o risco do QR

Na landing e na tela de conexão, em linguagem simples:

> **Conexão por QR code:** ideal para começar e para atendimento do dia a dia,
> com pouco volume. Não é a conexão oficial do WhatsApp, então disparos em massa
> ou muitas mensagens para quem não chamou podem levar ao bloqueio do número.
> Para campanhas e volume, use a API oficial.

No produto:

- Ao conectar por QR, o dono confirma que leu o aviso.
- Nos planos com QR, o envio de disparos fica bloqueado.
- Um limite diário de mensagens iniciadas pela empresa avisa antes de chegar
  perto de um padrão de risco.

### Consulta para refazer a medição de IA

```sql
select provider, model, count(*) calls,
       round(avg(prompt_tokens)) avg_in, round(avg(completion_tokens)) avg_out,
       round(avg(coalesce(cached_tokens, 0))) avg_cached
from ai_usage_log
where created_at > now() - interval '30 days'
group by 1, 2 order by calls desc;

select percentile_cont(0.5) within group (order by n) mediana, avg(n) media
from (select conversation_id, count(*) n from ai_usage_log group by 1) s;
```
