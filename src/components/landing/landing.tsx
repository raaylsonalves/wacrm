'use client';

// ============================================================
// Public marketing page for the Nordia CRM. Rendered at "/" only when
// NEXT_PUBLIC_LANDING_PAGE=on (see src/app/page.tsx). Copy is pt-BR on
// purpose: it is this deployment's storefront, not app UI, so it lives
// here instead of messages/*.json.
// ============================================================

import { useState, type FormEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { SCREEN_SIZE, screenHtml, type ScreenId } from './screens';
import { DemoFlow } from './demo';
import { LEAD_INTERESTS, type LeadInterest } from '@/lib/landing/lead';
import './landing.css';

const SALES_WHATSAPP = (process.env.NEXT_PUBLIC_SALES_WHATSAPP ?? '').replace(
  /\D/g,
  ''
);

function Screen({ id, scale }: { id: ScreenId; scale: number }) {
  const [w, h] = SCREEN_SIZE[id];
  return (
    <div
      className="lp-screen"
      style={{ width: Math.round(w * scale), height: Math.round(h * scale) }}
      aria-hidden="true"
    >
      <div
        className="lp-screen-stage"
        style={{ width: w, height: h, transform: `scale(${scale})` }}
        // Static markup authored in screens.ts — no user input reaches it.
        dangerouslySetInnerHTML={{ __html: screenHtml(id) }}
      />
    </div>
  );
}

function Phone({
  id,
  width,
  alt,
  className,
}: {
  id: ScreenId;
  width: number;
  alt: string;
  className?: string;
}) {
  return (
    <div
      className={`lp-phone ${className ?? ''}`}
      style={{ width }}
      role="img"
      aria-label={alt}
    >
      <div className="lp-phone-screen">
        <Screen id={id} scale={(width * 0.8941) / 390} />
      </div>
      <Image
        className="lp-phone-frame"
        src="/landing/iphone-frame-v3.png"
        alt=""
        width={444}
        height={903}
        priority
      />
      <span className="lp-phone-island" />
    </div>
  );
}

const Check = ({ color = 'currentColor' }: { color?: string }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flexShrink: 0, marginTop: 1 }}
  >
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

const SEGMENT_WORDS = [
  'Barbearias',
  'Clínicas',
  'Estética',
  'Correspondentes de crédito',
  'Imobiliárias',
  'Lojas',
  'Agências',
  'Academias',
  'Cursos',
  'Consultórios',
];
const STRIP_FACES: React.CSSProperties[] = [
  {
    fontFamily: 'var(--font-landing-serif), Georgia, serif',
    fontSize: 24,
    fontStyle: 'italic',
    fontWeight: 500,
  },
  {
    fontSize: 17,
    fontWeight: 700,
    letterSpacing: '.12em',
    textTransform: 'uppercase',
  },
  {
    fontFamily: 'var(--font-landing-serif), Georgia, serif',
    fontSize: 25,
    fontWeight: 500,
  },
  { fontSize: 21, fontWeight: 800, letterSpacing: '-0.04em' },
];

const STACK: {
  tela: ScreenId;
  url: string;
  kicker: string;
  tone: [string, string];
  title: string;
  body: string;
  points: string[];
}[] = [
  {
    tela: 'inbox',
    url: 'caixa-de-entrada',
    kicker: 'Caixa de entrada',
    tone: ['#dde8fb', '#23508e'],
    title: 'A IA responde. A equipe assume quando precisa.',
    body: 'Toda conversa com status, fila e histórico. O resumo da IA e o próximo passo ficam ao lado, para ninguém perguntar de novo.',
    points: [
      'IA e equipe na mesma conversa',
      'Resumo e memória de cada cliente',
      'Respostas rápidas e modelos aprovados',
    ],
  },
  {
    tela: 'agenda',
    url: 'agenda',
    kicker: 'Agenda',
    tone: ['#dcf1e6', '#1d6a46'],
    title: 'O cliente pede o horário, a IA marca.',
    body: 'A agenda de cada profissional fica visível para o agente, que marca, remarca e lembra o cliente antes do horário.',
    points: [
      'Marcação e remarcação pelo WhatsApp',
      'Lembretes automáticos',
      'Sincronização com o Google Agenda',
    ],
  },
  {
    tela: 'prospec',
    url: 'prospeccao',
    kicker: 'Prospecção',
    tone: ['#fde6cf', '#8a4a12'],
    title: 'Suba a planilha e acompanhe quem virou oportunidade.',
    body: 'Importe a lista do Google Maps, separe por segmento e veja abordados, respostas e qualificados de cada campanha.',
    points: [
      'Custo e limite da Meta antes de começar',
      'Anti-banimento no número próprio',
      'Funil por segmento',
    ],
  },
  {
    tela: 'negocios',
    url: 'negocios',
    kicker: 'Negócios',
    tone: ['#ece4fc', '#4a3794'],
    title: 'Da conversa ao fechamento, no mesmo funil.',
    body: 'Cada conversa pode virar negócio com etapa, valor e responsável. A IA move o card quando o cliente se qualifica.',
    points: [
      'Funil com valores e etapas',
      'Follow-up para quem sumiu',
      'Ganhos e perdidos do mês',
    ],
  },
  {
    tela: 'disparos',
    url: 'disparos',
    kicker: 'Disparos',
    tone: ['#fbe0e7', '#8e2b49'],
    title: 'Campanhas para a sua base, com relatório.',
    body: 'Escolha um modelo aprovado, filtre por etiqueta e acompanhe entrega e leitura. Quem pede para sair não recebe mais.',
    points: [
      'Segmentação por etiqueta',
      'Entrega e leitura acompanhadas',
      'Opt-out respeitado em todo envio',
    ],
  },
];

const SEGMENTS = [
  {
    bg: '#fde6cf',
    fg: '#8a4a12',
    icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8z',
    title: 'Prospecção de clientes',
    body: 'A IA aborda as empresas da sua lista e entrega para você só quem demonstrou interesse.',
    who: 'Agências, serviços B2B, representantes',
  },
  {
    bg: '#dcf1e6',
    fg: '#1d6a46',
    icon: 'M4 6h16v14H4zM8 3v4M16 3v4M4 11h16',
    title: 'Agendamentos',
    body: 'Horários marcados, remarcados e lembrados pelo próprio WhatsApp.',
    who: 'Barbearias, clínicas, estética',
  },
  {
    bg: '#dde8fb',
    fg: '#23508e',
    icon: 'M4 5h16v11H9l-5 4z',
    title: 'Atendimento personalizado',
    body: 'Agentes por setor e memória de cada cliente. Ninguém precisa repetir a história.',
    who: 'Lojas, suporte, pós-venda',
  },
  {
    bg: '#ece4fc',
    fg: '#4a3794',
    icon: 'M6 3v12a3 3 0 003 3h9M6 8a2 2 0 100-4M18 21a2 2 0 100-4',
    title: 'Vendas',
    body: 'Funil, follow-up automático e modelos aprovados para fechar mais rápido.',
    who: 'Imobiliárias, cursos, varejo',
  },
  {
    bg: '#fbe0e7',
    fg: '#8e2b49',
    icon: 'M4 7h16v12H4zM8 7V5h8v2M9 13h6',
    title: 'Crédito e empréstimos',
    body: 'Coleta de dados e documentos por fluxo, caso com responsável e LGPD em dia.',
    who: 'Correspondentes, financeiras',
  },
  {
    bg: '#efeae2',
    fg: '#3d3a35',
    icon: 'M7 7a7 7 0 000 10M17 7a7 7 0 010 10M12 10a2 2 0 110 4 2 2 0 010-4z',
    title: 'Disparos em massa',
    body: 'Campanhas para quem já é cliente, com entrega, leitura e respostas medidas.',
    who: 'Promoções, retornos, avisos',
  },
];

const PLANS = [
  {
    id: 'essencial',
    name: 'Essencial',
    price: 197,
    pitch: 'Para começar a atender com IA.',
    items: [
      '1 número de WhatsApp',
      '3 usuários',
      '1 agente de IA',
      'Caixa de entrada e funil',
      'Agenda com lembretes',
    ],
  },
  {
    id: 'profissional',
    name: 'Profissional',
    price: 397,
    hot: true,
    pitch: 'Para equipes que vendem e agendam todo dia.',
    items: [
      '2 números (oficial e/ou próprio)',
      '8 usuários',
      '5 agentes de IA e roteador',
      'Prospecção por planilha',
      'Disparos e follow-ups',
      'Google Agenda',
    ],
  },
  {
    id: 'escala',
    name: 'Escala',
    price: 797,
    pitch: 'Para operações com vários setores.',
    items: [
      '5 números',
      '20 usuários',
      'Agentes de IA ilimitados',
      'API, webhooks e MCP',
      'Suporte prioritário',
    ],
  },
];

const FAQ = [
  [
    'Preciso de um número novo?',
    'Não. Use a API oficial da Meta (ideal para escala e disparos) ou conecte o número que você já usa, lendo um QR code. Dá para ter os dois.',
  ],
  [
    'A IA responde sozinha o tempo todo?',
    'Ela responde, agenda e qualifica dentro das regras que você define. Quando o cliente pede uma pessoa ou o assunto foge do combinado, ela passa para a equipe com o histórico.',
  ],
  [
    'Quanto custa cada mensagem?',
    'O plano não cobra por mensagem. Na API oficial, a Meta cobra cada modelo entregue, direto na sua conta. O CRM mostra o limite e uma estimativa antes de cada campanha.',
  ],
  [
    'Como funciona o anual no Pix e no cartão?',
    'No anual você paga 10 meses e usa 12. No Pix é um pagamento único com 5% a mais de desconto; no cartão, parcela em até 12x.',
  ],
  [
    'Posso cancelar quando quiser?',
    'No mensal, sim: o acesso segue até o fim do período pago. No anual, o plano vale até o fim dos 12 meses.',
  ],
  [
    'E a LGPD?',
    'Cada campanha registra a base legal, quem pede para sair deixa de receber e você pode anonimizar um contato quando quiser.',
  ],
];

const FORM_ERRORS: Record<string, string> = {
  invalid_phone: 'Confira o WhatsApp: use DDD + número, como (85) 99999-0000.',
  rate: 'Muitas tentativas seguidas. Tente de novo em alguns minutos.',
  not_configured:
    'O formulário ainda não está ativo. Fale com a gente pelo WhatsApp.',
  failed: 'Não conseguimos enviar agora. Tente de novo em instantes.',
};

const brl = (n: number) =>
  n.toLocaleString('pt-BR', {
    minimumFractionDigits: n % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  });

export function Landing() {
  const [annual, setAnnual] = useState(false);
  const [pix, setPix] = useState(true);
  const [open, setOpen] = useState(0);
  const [need, setNeed] = useState<LeadInterest>(LEAD_INTERESTS[0]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const payNote = annual
    ? pix
      ? 'Anual no Pix: pagamento único com 5% de desconto, além dos 2 meses grátis.'
      : 'Anual no cartão: parcele em até 12x sem juros.'
    : pix
      ? 'Mensal no Pix: cobrança todo mês. Cancele quando quiser.'
      : 'Mensal no cartão: renovação automática. Cancele quando quiser.';

  async function sendLead(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    setFormError(null);
    setSending(true);
    try {
      const res = await fetch('/api/landing/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, interest: need, website }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) setSent(true);
      else setFormError(res.status === 429 ? 'rate' : (data.error ?? 'failed'));
    } catch {
      setFormError('failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="lp">
      {/* ============ HERO + ARCO ============ */}
      <div className="lp-heroBox">
        <section id="topo" className="lp-hero">
          <header className="lp-nav">
            <Link href="/" aria-label="Nordia CRM" style={{ display: 'flex' }}>
              <Image
                src="/landing/nordia-logo.png"
                alt="Nordia CRM"
                width={480}
                height={164}
                style={{ height: 30, width: 'auto' }}
                priority
              />
            </Link>
            <nav aria-label="Principal" className="lp-nav-links lp-hide-sm">
              <a href="#produto">Produto</a>
              <a href="#segmentos">Segmentos</a>
              <a href="#studio">Nordia Studio</a>
              <a href="#planos">Planos</a>
            </nav>
            <span
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                marginLeft: 'auto',
              }}
            >
              <Link
                href="/login"
                className="lp-btn lp-hide-sm"
                style={{ minHeight: 44, padding: '0 16px', fontWeight: 500 }}
              >
                Entrar
              </Link>
              <Link
                href="/signup"
                className="lp-btn lp-btn-dark"
                style={{ minHeight: 46 }}
              >
                Começar agora
              </Link>
            </span>
          </header>

          <div className="lp-hero-copy">
            <h1 className="lp-serif lp-enter">
              Atenda, agende e venda pelo WhatsApp com IA
            </h1>
            <p className="lp-enter lp-e1">
              A IA responde seus clientes na hora, marca horários e qualifica
              leads. A sua equipe entra quando precisa, com todo o histórico.
            </p>
            <div
              className="lp-enter lp-e2"
              style={{
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
                justifyContent: 'center',
              }}
            >
              <Link href="/signup" className="lp-btn lp-btn-dark">
                Começar agora
              </Link>
              <a href="#produto" className="lp-btn lp-btn-line">
                Ver demonstração
              </a>
            </div>
          </div>

          <div className="lp-stage">
            <span
              aria-hidden="true"
              className="lp-ring"
              style={{ top: 10, width: 1240, height: 1240 }}
            />
            <span
              aria-hidden="true"
              className="lp-ring"
              style={{ top: 80, width: 960, height: 960 }}
            />
            <span aria-hidden="true" className="lp-sun lp-enter lp-e2" />
            <div className="lp-hero-phone">
              <Phone
                id="conversaM"
                width={300}
                alt="Celular com uma conversa atendida pela IA do Nordia CRM"
                className="lp-enter lp-e3"
              />
            </div>

            <div
              className="lp-float lp-hide-sm"
              style={
                {
                  '--d': 1.1,
                  left: 'calc(50% - 440px)',
                  top: 0,
                } as React.CSSProperties
              }
            >
              <div
                className="lp-enter lp-e4 lp-bob"
                style={{
                  width: 150,
                  borderRadius: 18,
                  background: '#dde8fb',
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  boxShadow: '0 20px 40px -24px rgba(35,80,142,.45)',
                }}
              >
                <span
                  style={{
                    alignSelf: 'flex-start',
                    borderRadius: 999,
                    background: '#fff',
                    padding: '3px 9px',
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#23508e',
                  }}
                >
                  Qua, 7 out
                </span>
                <span
                  style={{
                    fontSize: 30,
                    fontWeight: 800,
                    letterSpacing: '-0.04em',
                    lineHeight: 1,
                  }}
                >
                  14:00
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: '#23508e',
                    lineHeight: 1.35,
                  }}
                >
                  Corte + barba
                  <br />
                  com o Rafa
                </span>
              </div>
            </div>
            <div
              className="lp-float lp-hide-sm"
              style={
                {
                  '--d': 1.4,
                  left: 'calc(50% - 330px)',
                  top: 178,
                } as React.CSSProperties
              }
            >
              <span
                className="lp-enter lp-e5 lp-bob2"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  borderRadius: 999,
                  background: '#fbd3ec',
                  padding: '8px 14px',
                  fontSize: 13,
                  fontWeight: 700,
                  color: '#6d1f4c',
                }}
              >
                <Check />
                Agendado pela IA
              </span>
            </div>
            <div
              className="lp-float lp-hide-sm"
              style={
                {
                  '--d': 0.8,
                  left: 'calc(50% - 500px)',
                  top: 250,
                } as React.CSSProperties
              }
            >
              <div
                className="lp-enter lp-e6 lp-bob"
                style={{
                  borderRadius: 18,
                  background: '#ffe08a',
                  padding: '16px 18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  boxShadow: '0 20px 40px -24px rgba(138,100,0,.45)',
                }}
              >
                <svg
                  width="54"
                  height="40"
                  viewBox="0 0 54 40"
                  aria-hidden="true"
                >
                  <rect
                    x="0"
                    y="14"
                    width="10"
                    height="26"
                    rx="2"
                    fill="#3b2a12"
                  />
                  <rect
                    x="14"
                    y="2"
                    width="10"
                    height="38"
                    rx="2"
                    fill="#3b2a12"
                  />
                  <rect
                    x="28"
                    y="22"
                    width="10"
                    height="18"
                    rx="2"
                    fill="#3b2a12"
                  />
                  <rect
                    x="42"
                    y="8"
                    width="10"
                    height="32"
                    rx="2"
                    fill="#3b2a12"
                  />
                </svg>
                <span
                  style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                >
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: '#6b5310',
                    }}
                  >
                    Taxa de resposta
                  </span>
                  <span
                    style={{
                      fontSize: 30,
                      fontWeight: 800,
                      letterSpacing: '-0.04em',
                      color: '#2a1e08',
                      lineHeight: 1,
                    }}
                  >
                    24%
                  </span>
                </span>
              </div>
            </div>
            <div
              className="lp-float lp-hide-sm"
              style={
                {
                  '--d': 1.2,
                  left: 'calc(50% + 230px)',
                  top: 10,
                } as React.CSSProperties
              }
            >
              <div
                className="lp-enter lp-e4 lp-bob2"
                style={{
                  width: 200,
                  borderRadius: 20,
                  background: '#c7efd2',
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  boxShadow: '0 20px 40px -24px rgba(29,106,70,.45)',
                  color: '#10351f',
                }}
              >
                <span
                  style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}
                >
                  <span
                    style={{
                      fontSize: 44,
                      fontWeight: 800,
                      letterSpacing: '-0.05em',
                      lineHeight: 1,
                    }}
                  >
                    9
                  </span>
                  <span style={{ fontSize: 17, fontWeight: 700 }}>
                    agendados
                  </span>
                </span>
                <span
                  style={{ fontSize: 12.5, fontWeight: 600, color: '#1d6a46' }}
                >
                  hoje, 6 deles pela IA
                </span>
                <span
                  style={{
                    alignSelf: 'flex-start',
                    borderRadius: 999,
                    background: '#fff',
                    padding: '5px 11px',
                    fontSize: 13,
                    fontWeight: 800,
                  }}
                >
                  R$ 630
                </span>
              </div>
            </div>
            <div
              className="lp-float lp-hide-sm"
              style={
                {
                  '--d': 0.9,
                  left: 'calc(50% + 300px)',
                  top: 200,
                } as React.CSSProperties
              }
            >
              <div
                className="lp-enter lp-e6 lp-bob"
                style={{
                  width: 190,
                  borderRadius: 18,
                  background: '#fff',
                  border: '1px solid #ebe5da',
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  boxShadow: '0 24px 50px -24px rgba(22,21,26,.3)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 999,
                      background: '#ef9d7f',
                      fontWeight: 800,
                      fontSize: 12,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    RV
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}>
                    <b style={{ fontSize: 13 }}>Ricardo Veículos</b>
                    <span style={{ fontSize: 11, color: '#625d55' }}>
                      respondeu agora
                    </span>
                  </span>
                </span>
                <span
                  style={{
                    alignSelf: 'flex-start',
                    borderRadius: 999,
                    background: '#ece4fc',
                    padding: '4px 10px',
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: '#4a3794',
                  }}
                >
                  Lead qualificado
                </span>
                <span
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 11.5,
                    color: '#625d55',
                    borderTop: '1px solid #f0ebe2',
                    paddingTop: 8,
                  }}
                >
                  <span>Prospecção</span>
                  <b style={{ color: '#16151a' }}>Revendas · CE</b>
                </span>
              </div>
            </div>
          </div>

          <div className="lp-hero-strip" aria-label="Segmentos atendidos">
            <div className="lp-mq">
              {SEGMENT_WORDS.concat(SEGMENT_WORDS).map((w, i) => (
                <span
                  key={i}
                  style={{
                    ...STRIP_FACES[i % STRIP_FACES.length],
                    color: '#8a8378',
                  }}
                >
                  {w}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section aria-label="O CRM no celular" className="lp-archSec">
          <div className="lp-arch">
            <div className="lp-arch-line" />
            <div className="lp-arch-head">
              <span className="lp-eyebrow" style={{ color: '#d4c6ff' }}>
                No bolso da sua equipe
              </span>
              <h2 className="lp-h2" style={{ maxWidth: 760 }}>
                Do primeiro “oi” ao horário marcado, sem ninguém parar o que
                está fazendo.
              </h2>
            </div>
            <div className="lp-pile">
              <div className="lp-pile-l">
                <Phone
                  id="agendaM"
                  width={280}
                  alt="Agenda do dia no celular"
                />
              </div>
              <div className="lp-pile-r">
                <Phone
                  id="prospecM"
                  width={280}
                  alt="Campanha de prospecção no celular"
                />
              </div>
              <div className="lp-pile-c">
                <Phone
                  id="conversaM"
                  width={320}
                  alt="Conversa atendida pela IA no celular"
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ============ PRODUTO ============ */}
      <section
        id="produto"
        className="lp-sec"
        style={{ padding: '120px 20px 40px' }}
      >
        <div
          className="lp-wrap"
          style={{ display: 'flex', flexDirection: 'column', gap: 22 }}
        >
          <div
            className="lp-rise"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 20,
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              marginBottom: 26,
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                maxWidth: 700,
              }}
            >
              <span className="lp-eyebrow">O sistema</span>
              <h2 className="lp-h2">
                Tudo que acontece no WhatsApp, organizado em um só lugar.
              </h2>
            </div>
            <p
              style={{
                margin: 0,
                maxWidth: 340,
                fontSize: 16,
                lineHeight: 1.6,
                color: 'var(--muted)',
              }}
            >
              Telas do Nordia CRM com dados de exemplo.
            </p>
          </div>
          {STACK.map((s, i) => (
            <article
              key={s.tela}
              className="lp-stack-card"
              style={{ top: 90 + i * 18 }}
            >
              <div
                style={{
                  flex: '1 1 300px',
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                }}
              >
                <span
                  style={{
                    alignSelf: 'flex-start',
                    borderRadius: 999,
                    padding: '4px 12px',
                    fontSize: 12,
                    fontWeight: 700,
                    background: s.tone[0],
                    color: s.tone[1],
                  }}
                >
                  {s.kicker}
                </span>
                <h3
                  style={{
                    margin: 0,
                    fontSize: 'clamp(24px, 2.6vw, 34px)',
                    lineHeight: 1.1,
                    fontWeight: 800,
                    letterSpacing: '-0.03em',
                  }}
                >
                  {s.title}
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: 15.5,
                    lineHeight: 1.6,
                    color: 'var(--muted)',
                  }}
                >
                  {s.body}
                </p>
                <ul
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 9,
                    fontWeight: 600,
                    fontSize: 14.5,
                  }}
                >
                  {s.points.map((p) => (
                    <li key={p} className="lp-check">
                      <Check color="#6a3fd8" />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              <div
                style={{
                  flex: '1.6 1 560px',
                  minWidth: 0,
                  display: 'flex',
                  justifyContent: 'center',
                }}
              >
                <div className="lp-shot">
                  <div className="lp-shot-bar">
                    <i />
                    <i />
                    <i />
                    <span>crm.nordiatech.com.br/{s.url}</span>
                  </div>
                  <Screen id={s.tela} scale={0.52} />
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ============ SEGMENTOS ============ */}
      <section
        id="segmentos"
        className="lp-sec"
        style={{ padding: '90px 20px 110px' }}
      >
        <div
          className="lp-wrap"
          style={{ display: 'flex', flexDirection: 'column', gap: 36 }}
        >
          <div
            className="lp-rise"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              maxWidth: 720,
            }}
          >
            <span className="lp-eyebrow">Segmentos</span>
            <h2 className="lp-h2">
              Feito para quem vende, agenda e atende pelo WhatsApp.
            </h2>
          </div>
          <div className="lp-segs">
            {SEGMENTS.map((g) => (
              <div key={g.title} className="lp-seg">
                <span
                  className="lp-seg-icon"
                  style={{ background: g.bg, color: g.fg }}
                >
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d={g.icon} />
                  </svg>
                </span>
                <span
                  style={{
                    fontSize: 19,
                    fontWeight: 800,
                    letterSpacing: '-0.02em',
                  }}
                >
                  {g.title}
                </span>
                <span
                  style={{
                    fontSize: 14.5,
                    lineHeight: 1.6,
                    color: 'var(--muted)',
                  }}
                >
                  {g.body}
                </span>
                <span
                  style={{
                    marginTop: 'auto',
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'var(--soft)',
                  }}
                >
                  {g.who}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ VEJA EM AÇÃO ============ */}
      <DemoFlow />

      {/* ============ NORDIA STUDIO ============ */}
      <section id="studio" className="lp-sec" style={{ padding: '110px 20px' }}>
        <div className="lp-wrap lp-studio">
          <div
            style={{
              flex: '1 1 420px',
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
            }}
          >
            <span className="lp-eyebrow" style={{ color: '#4a3794' }}>
              Nordia Studio · sob medida
            </span>
            <h2
              className="lp-h2"
              style={{ fontSize: 'clamp(30px, 4vw, 48px)' }}
            >
              Precisa de mais que o CRM? Construímos com você.
            </h2>
            <p
              style={{
                margin: 0,
                fontSize: 16,
                lineHeight: 1.6,
                color: '#4a3794',
              }}
            >
              O mesmo time que desenvolve o Nordia CRM entrega a parte que é só
              sua, já ligada ao seu WhatsApp e ao seu funil.
            </p>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                borderTop: '1px solid #cdb8f6',
              }}
            >
              <div className="lp-studio-row">
                <b>Landing page da sua marca</b>
                <span style={{ color: '#4a3794', lineHeight: 1.5 }}>
                  Captura direto no CRM e botão de WhatsApp com a IA esperando.
                </span>
              </div>
              <div className="lp-studio-row">
                <b>Sistema de agendamento</b>
                <span style={{ color: '#4a3794', lineHeight: 1.5 }}>
                  Agenda online por profissional, sinal no Pix e lembretes.
                </span>
              </div>
              <div className="lp-studio-row">
                <b>Integrações</b>
                <span style={{ color: '#4a3794', lineHeight: 1.5 }}>
                  ERP, planilhas, sistemas de crédito ou loja, pela API e
                  webhooks.
                </span>
              </div>
              <div className="lp-studio-row">
                <b>Implantação assistida</b>
                <span style={{ color: '#4a3794', lineHeight: 1.5 }}>
                  Agentes, fluxos e funil do seu segmento, com treinamento da
                  equipe.
                </span>
              </div>
            </div>
          </div>
          <form className="lp-form" onSubmit={sendLead} noValidate>
            <b style={{ fontSize: 20, letterSpacing: '-0.02em' }}>
              Fale com a gente
            </b>
            {sent ? (
              <div className="lp-sent" role="status">
                <b>Recebemos seu contato.</b>
                <span>Vamos te chamar no WhatsApp em horário comercial.</span>
                {SALES_WHATSAPP && (
                  <a
                    href={`https://wa.me/${SALES_WHATSAPP}?text=${encodeURIComponent(`Olá! Sou ${name.trim() || 'um interessado'} e quero um orçamento de: ${need}.`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="lp-btn lp-btn-line"
                  >
                    Prefiro falar agora no WhatsApp
                  </a>
                )}
              </div>
            ) : (
              <>
                <label htmlFor="lp-nome">
                  Nome
                  <input
                    id="lp-nome"
                    type="text"
                    autoComplete="name"
                    placeholder="Seu nome"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label htmlFor="lp-zap">
                  WhatsApp
                  <input
                    id="lp-zap"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="(85) 99999-0000"
                    value={phone}
                    aria-invalid={formError === 'invalid_phone'}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
                {/* Honeypot: hidden from people, filled by bots. */}
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  className="lp-hp"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
                <span style={{ fontSize: 13, fontWeight: 700 }}>Interesse</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {LEAD_INTERESTS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className="lp-tag"
                      aria-pressed={need === n}
                      onClick={() => setNeed(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                {formError && (
                  <span className="lp-form-error" role="alert">
                    {FORM_ERRORS[formError] ?? FORM_ERRORS.failed}
                  </span>
                )}
                <button
                  type="submit"
                  className="lp-btn lp-btn-dark"
                  style={{ marginTop: 4 }}
                  disabled={sending}
                >
                  {sending ? 'Enviando…' : 'Quero ser chamado'}
                </button>
              </>
            )}
          </form>
        </div>
      </section>

      {/* ============ PLANOS ============ */}
      <section
        id="planos"
        className="lp-sec"
        style={{ padding: '20px 20px 110px' }}
      >
        <div
          style={{
            maxWidth: 1220,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
        >
          <div
            className="lp-rise"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              alignItems: 'center',
              textAlign: 'center',
            }}
          >
            <span className="lp-eyebrow">Planos</span>
            <h2 className="lp-h2">
              Comece pequeno. Cresça sem trocar de sistema.
            </h2>
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              justifyContent: 'center',
            }}
          >
            <div role="group" aria-label="Período" className="lp-switch">
              <button
                type="button"
                aria-pressed={!annual}
                onClick={() => setAnnual(false)}
              >
                Mensal
              </button>
              <button
                type="button"
                aria-pressed={annual}
                onClick={() => setAnnual(true)}
              >
                Anual{' '}
                <span
                  style={{
                    borderRadius: 999,
                    padding: '2px 8px',
                    fontSize: 11,
                    background: '#dcf1e6',
                    color: '#1d6a46',
                  }}
                >
                  2 meses grátis
                </span>
              </button>
            </div>
            <div role="group" aria-label="Pagamento" className="lp-switch">
              <button
                type="button"
                aria-pressed={pix}
                onClick={() => setPix(true)}
              >
                Pix
              </button>
              <button
                type="button"
                aria-pressed={!pix}
                onClick={() => setPix(false)}
              >
                Cartão de crédito
              </button>
            </div>
          </div>
          <p
            style={{
              margin: 0,
              textAlign: 'center',
              fontSize: 14,
              color: 'var(--muted)',
              fontWeight: 600,
            }}
          >
            {payNote}
          </p>
          <div className="lp-plans" style={{ marginTop: 10 }}>
            {PLANS.map((p) => {
              const year = p.price * 10;
              const yearPix = Math.round(year * 0.95);
              const per = annual ? (pix ? yearPix : year) / 12 : p.price;
              const billing = !annual
                ? pix
                  ? 'Pix todo mês, sem fidelidade'
                  : 'Cobrança recorrente no cartão'
                : pix
                  ? `R$ ${brl(yearPix)} à vista no Pix (5% off)`
                  : `12x de R$ ${brl(Math.round((year / 12) * 100) / 100)} no cartão`;
              const muted = p.hot ? '#aaa5b5' : 'var(--muted)';
              return (
                <div
                  key={p.id}
                  className={p.hot ? 'lp-plan lp-plan-hot' : 'lp-plan'}
                >
                  <span
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 18, fontWeight: 800 }}>
                      {p.name}
                    </span>
                    {p.hot && (
                      <span
                        style={{
                          borderRadius: 999,
                          padding: '3px 10px',
                          fontSize: 11,
                          fontWeight: 700,
                          background: '#b9a2f2',
                          color: '#16151a',
                        }}
                      >
                        Mais escolhido
                      </span>
                    )}
                  </span>
                  <span
                    style={{
                      fontSize: 14,
                      lineHeight: 1.5,
                      minHeight: 42,
                      color: muted,
                    }}
                  >
                    {p.pitch}
                  </span>
                  <span
                    style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}
                  >
                    <span style={{ fontWeight: 700 }}>R$</span>
                    <span
                      style={{
                        fontSize: 48,
                        fontWeight: 800,
                        letterSpacing: '-0.05em',
                        lineHeight: 1,
                      }}
                    >
                      {brl(Math.round(per))}
                    </span>
                    <span style={{ fontSize: 14, color: muted }}>/mês</span>
                  </span>
                  <span style={{ fontSize: 13, minHeight: 20, color: muted }}>
                    {billing}
                  </span>
                  <Link
                    href={`/signup?plano=${p.id}`}
                    className="lp-btn"
                    style={
                      p.hot
                        ? { background: '#b9a2f2', color: '#16151a' }
                        : { background: '#16151a', color: '#fff' }
                    }
                  >
                    Assinar {p.name}
                  </Link>
                  <ul>
                    {p.items.map((it) => (
                      <li key={it}>
                        <Check />
                        {it}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <div
              className="lp-plan"
              style={{ borderStyle: 'dashed', borderColor: '#b9a2f2' }}
            >
              <span style={{ fontSize: 18, fontWeight: 800 }}>Sob medida</span>
              <span
                style={{
                  fontSize: 14,
                  lineHeight: 1.5,
                  minHeight: 42,
                  color: 'var(--muted)',
                }}
              >
                Módulos, integrações e telas que ainda não existem no CRM.
              </span>
              <span
                style={{
                  fontSize: 30,
                  fontWeight: 800,
                  letterSpacing: '-0.04em',
                  lineHeight: 1.1,
                }}
              >
                Sob consulta
              </span>
              <span
                style={{ fontSize: 13, minHeight: 20, color: 'var(--muted)' }}
              >
                Orçamento em até 2 dias úteis
              </span>
              <a href="#studio" className="lp-btn lp-btn-line">
                Falar com a Nordia
              </a>
              <ul style={{ color: '#3d3a35' }}>
                {[
                  'Tudo do plano Escala',
                  'Módulos e telas novas',
                  'Landing page e agendamento próprios',
                  'Instalação no seu servidor',
                  'Gerente de conta dedicado',
                ].map((it) => (
                  <li key={it}>
                    <Check />
                    {it}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p
            style={{
              margin: '6px 0 0',
              textAlign: 'center',
              fontSize: 13,
              color: 'var(--soft)',
              lineHeight: 1.6,
            }}
          >
            Mensagens pela API oficial são cobradas pela Meta, direto na sua
            conta. O número próprio não tem custo por mensagem.
          </p>
        </div>
      </section>

      {/* ============ DÚVIDAS ============ */}
      <section
        id="duvidas"
        className="lp-sec"
        style={{ padding: '0 20px 110px' }}
      >
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
          <h2
            className="lp-h2"
            style={{ fontSize: 'clamp(30px, 3.8vw, 44px)', marginBottom: 22 }}
          >
            Dúvidas frequentes
          </h2>
          {FAQ.map(([q, a], i) => (
            <div key={q} className="lp-faq-item" data-open={open === i}>
              <button
                type="button"
                aria-expanded={open === i}
                onClick={() => setOpen(open === i ? -1 : i)}
              >
                {q}
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              {open === i && (
                <p
                  className="lp-enter"
                  style={{
                    margin: 0,
                    padding: '0 40px 22px 0',
                    fontSize: 15,
                    lineHeight: 1.65,
                    color: 'var(--muted)',
                  }}
                >
                  {a}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ============ RODAPÉ ============ */}
      <footer className="lp-foot">
        <div
          className="lp-wrap"
          style={{
            padding: '70px 20px 30px',
            display: 'flex',
            flexDirection: 'column',
            gap: 50,
          }}
        >
          <div className="lp-foot-cols">
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
                maxWidth: 320,
              }}
            >
              <span className="lp-foot-logo">
                <Image
                  src="/landing/nordia-logo.png"
                  alt="Nordia CRM"
                  width={480}
                  height={164}
                  style={{ height: 26, width: 'auto' }}
                />
              </span>
              <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6 }}>
                CRM para WhatsApp com IA: atendimento, agenda, prospecção e
                vendas num lugar só.
              </p>
            </div>
            <div>
              <h3>Produto</h3>
              <ul>
                <li>
                  <a href="#produto">Caixa de entrada</a>
                </li>
                <li>
                  <a href="#produto">Agenda</a>
                </li>
                <li>
                  <a href="#produto">Prospecção</a>
                </li>
                <li>
                  <a href="#produto">Negócios</a>
                </li>
                <li>
                  <a href="#produto">Disparos</a>
                </li>
              </ul>
            </div>
            <div>
              <h3>Nordia</h3>
              <ul>
                <li>
                  <a href="#studio">Nordia Studio</a>
                </li>
                <li>
                  <a href="#planos">Planos</a>
                </li>
                <li>
                  <a href="#duvidas">Dúvidas</a>
                </li>
                <li>
                  <Link href="/login">Entrar</Link>
                </li>
              </ul>
            </div>
            <div>
              <h3>Legal</h3>
              <ul>
                <li>
                  <a href="#termos">Termos de uso</a>
                </li>
                <li>
                  <a href="#privacidade">Privacidade e LGPD</a>
                </li>
              </ul>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              gap: 12,
              paddingTop: 24,
              borderTop: '1px solid #2f2d37',
              fontSize: 13,
              color: '#8d879a',
            }}
          >
            <span>
              © {new Date().getFullYear()} Nordia Tech. Todos os direitos
              reservados.
            </span>
            <span>WhatsApp é uma marca da Meta Platforms, Inc.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
