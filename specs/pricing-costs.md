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
