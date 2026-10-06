'use client';

// ============================================================
// "Veja em ação": a self-playing walkthrough of one customer's day in
// the CRM. Each step swaps the animated screen, drops a notification
// card where the action happens and moves a pointer to it — a product
// video built from the same live screens, so it never goes stale.
// Plays only while on screen; respects prefers-reduced-motion.
// ============================================================

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SCREEN_SIZE, screenHtml, type ScreenId } from './screens';

const STEP_MS = 5200;

interface Step {
  time: string;
  who: string;
  tone: [string, string];
  title: string;
  body: string;
  screen: ScreenId;
  // Notification card and pointer, in % of the stage.
  card: {
    x: number;
    y: number;
    title: string;
    text: string;
    tone: [string, string];
  };
  pointer: { x: number; y: number };
}

const STEPS: Step[] = [
  {
    time: '10:46',
    who: 'IA',
    tone: ['#2c2442', '#d4c6ff'],
    title: 'Responde na hora',
    body: 'Preços, serviços e horários da casa, no tom que você definiu.',
    screen: 'inbox',
    card: {
      x: 47,
      y: 12,
      title: 'Nova mensagem',
      text: 'Lucas Ferreira: “tem amanhã?” · respondida pela IA em 4 s',
      tone: ['#2c2442', '#d4c6ff'],
    },
    pointer: { x: 52, y: 40 },
  },
  {
    time: '10:48',
    who: 'IA',
    tone: ['#2c2442', '#d4c6ff'],
    title: 'Marca na agenda do Rafa',
    body: 'Consulta a agenda do profissional e cria o negócio no funil.',
    screen: 'agenda',
    card: {
      x: 44,
      y: 18,
      title: 'Agendado pela IA',
      text: 'Qua, 7 out · 14:00 · Corte + barba com o Rafa',
      tone: ['#173328', '#9fe3c2'],
    },
    pointer: { x: 46, y: 70 },
  },
  {
    time: '13:00',
    who: 'Automação',
    tone: ['#1b2a42', '#a9c6f5'],
    title: 'Lembrete 1 hora antes',
    body: 'Se o cliente pedir para remarcar, a IA resolve na mesma conversa.',
    screen: 'inbox',
    card: {
      x: 46,
      y: 60,
      title: 'Lembrete enviado',
      text: '“Lucas, seu horário com o Rafa é às 14:00. Até já!”',
      tone: ['#1b2a42', '#a9c6f5'],
    },
    pointer: { x: 60, y: 86 },
  },
  {
    time: '14:02',
    who: 'Equipe',
    tone: ['#3a2817', '#f8c38f'],
    title: 'O Rafa atende já sabendo de tudo',
    body: 'Histórico, resumo da IA e preferências do cliente ao lado da conversa.',
    screen: 'inbox',
    card: {
      x: 58,
      y: 26,
      title: 'Rafa assumiu a conversa',
      text: 'Resumo da IA: corta a cada 4 semanas, prefere a tarde.',
      tone: ['#3a2817', '#f8c38f'],
    },
    pointer: { x: 88, y: 34 },
  },
  {
    time: '14:45',
    who: 'Funil',
    tone: ['#173328', '#9fe3c2'],
    title: 'Negócio ganho: R$ 70',
    body: 'O valor entra no painel e no relatório do mês.',
    screen: 'negocios',
    card: {
      x: 52,
      y: 6,
      title: 'Negócio ganho',
      text: 'Lucas Ferreira · Corte + barba · R$ 70',
      tone: ['#173328', '#9fe3c2'],
    },
    pointer: { x: 52, y: 58 },
  },
  {
    time: '+28 dias',
    who: 'Follow-up',
    tone: ['#3a1f29', '#f5b3c6'],
    title: '“Bora marcar o próximo?”',
    body: 'A mensagem sai sozinha quando chega a hora do retorno.',
    screen: 'inbox',
    card: {
      x: 46,
      y: 54,
      title: 'Follow-up enviado',
      text: '“E aí, Lucas! Já faz 4 semanas. Bora marcar o próximo?”',
      tone: ['#3a1f29', '#f5b3c6'],
    },
    pointer: { x: 30, y: 26 },
  },
];

const SCALE = 0.6;

const reducedMotionQuery = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)');
function subscribeReducedMotion(cb: () => void) {
  const mq = reducedMotionQuery();
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

export function DemoFlow() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => reducedMotionQuery().matches,
    () => false
  );
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), {
      threshold: 0.35,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const running = playing && visible && !reduced;
  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(
      () => setStep((s) => (s + 1) % STEPS.length),
      STEP_MS
    );
    return () => window.clearTimeout(t);
  }, [running, step]);

  const s = STEPS[step];
  const [w, h] = SCREEN_SIZE[s.screen];

  return (
    <section
      ref={ref}
      className="lp-sec lp-demo"
      aria-label="Demonstração do Nordia CRM"
    >
      <div className="lp-wrap">
        <div className="lp-demo-head">
          <span className="lp-eyebrow" style={{ color: '#d4c6ff' }}>
            Veja em ação
          </span>
          <h2 className="lp-h2">Um cliente, do primeiro “oi” ao retorno.</h2>
          <p>Um dia na Barbearia Navalha, passo a passo, dentro do CRM.</p>
        </div>
        <div className="lp-demo-grid">
          <ol className="lp-demo-steps">
            {STEPS.map((st, i) => (
              <li key={st.time}>
                <button
                  type="button"
                  className="lp-demo-step"
                  aria-current={i === step ? 'step' : undefined}
                  onClick={() => setStep(i)}
                >
                  <span className="lp-demo-meta">
                    <span className="lp-demo-time">{st.time}</span>
                    <span
                      className="lp-demo-who"
                      style={{ background: st.tone[0], color: st.tone[1] }}
                    >
                      {st.who}
                    </span>
                  </span>
                  <b>{st.title}</b>
                  {i === step && (
                    <span className="lp-demo-body">{st.body}</span>
                  )}
                  <span className="lp-demo-progress" aria-hidden="true">
                    {i === step && (
                      <span
                        key={`${step}-${running}`}
                        className="lp-demo-progress-fill"
                        style={{
                          animationDuration: `${STEP_MS}ms`,
                          animationPlayState: running ? 'running' : 'paused',
                        }}
                      />
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>

          <div className="lp-demo-stage-wrap">
            <div className="lp-shot lp-demo-shot">
              <div className="lp-shot-bar">
                <i />
                <i />
                <i />
                <span>crm.nordiatech.com.br</span>
                <button
                  type="button"
                  className="lp-demo-play"
                  onClick={() => setPlaying((p) => !p)}
                  aria-label={
                    playing ? 'Pausar demonstração' : 'Reproduzir demonstração'
                  }
                >
                  {playing ? (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <rect x="5" y="4" width="5" height="16" rx="1" />
                      <rect x="14" y="4" width="5" height="16" rx="1" />
                    </svg>
                  ) : (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M7 4l13 8-13 8z" />
                    </svg>
                  )}
                </button>
              </div>
              <div
                className="lp-demo-stage"
                style={{
                  width: Math.round(w * SCALE),
                  height: Math.round(h * SCALE),
                }}
              >
                <div
                  key={`${s.screen}-${step}`}
                  className="lp-screen-stage lp-demo-screen"
                  style={{ width: w, height: h, transform: `scale(${SCALE})` }}
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: screenHtml(s.screen) }}
                />
                <div
                  key={`card-${step}`}
                  className="lp-demo-card"
                  role="status"
                  style={{ left: `${s.card.x}%`, top: `${s.card.y}%` }}
                >
                  <span
                    className="lp-demo-card-dot"
                    style={{ background: s.card.tone[1] }}
                  />
                  <span>
                    <b style={{ color: s.card.tone[1] }}>{s.card.title}</b>
                    <span>{s.card.text}</span>
                  </span>
                </div>
                <svg
                  className="lp-demo-pointer"
                  style={{ left: `${s.pointer.x}%`, top: `${s.pointer.y}%` }}
                  width="26"
                  height="26"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    d="M5 3l14 8-6 2-3 6z"
                    fill="#fff"
                    stroke="#16151a"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
