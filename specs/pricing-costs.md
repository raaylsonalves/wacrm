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

### 4.1 IA gerenciada pela Nordia, com travas

O atrito de hoje: o cliente precisa criar uma chave na OpenAI, cadastrar um
cartão em dólar e configurar tudo. Para uma clínica ou imobiliária, isso trava a
venda. "IA inclusa" é um diferencial na landing.

1. **Modelo fixo e leve por plano**, como Gemini Flash-Lite ou GPT-4o-mini, com a
   chave da Nordia guardada em variável de ambiente e nunca exposta ao cliente.
   Quem quiser um modelo top continua podendo usar a própria chave, como funciona
   hoje.
2. **Cota de conversas com IA por plano.** Sugestão inicial: Essencial 1.000,
   Profissional 3.000, Escala 8.000. Ao bater a cota, a IA pausa com aviso para
   o dono, ou o cliente compra um pacote extra.
   Isso fecha o item aberto "teto mensal de gasto com IA" de
   `review-2026-10.md`.
3. **Painel interno de custo por cliente**, só para operadores da plataforma:
   tokens e R$ estimados no mês, por conta, comparados ao valor do plano.

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
