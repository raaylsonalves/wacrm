// ============================================================
// Animated CRM screens for the marketing landing. They mirror the real
// v2 dashboard (same sidebar, cards and tone chips) with demo data, and
// loop their own entrance animations (classes in landing.css).
//
// Built as static HTML strings: the content is ours and fixed, there is
// no user input, and it keeps ~8 dense screens out of the React tree.
// ============================================================

export type ScreenId =
  | 'conversaM'
  | 'prospecM'
  | 'agendaM'
  | 'inbox'
  | 'prospec'
  | 'negocios'
  | 'agenda'
  | 'disparos';

export const SCREEN_SIZE: Record<ScreenId, [number, number]> = {
  conversaM: [390, 852],
  prospecM: [390, 852],
  agendaM: [390, 852],
  inbox: [1280, 800],
  prospec: [1280, 800],
  negocios: [1280, 800],
  agenda: [1280, 800],
  disparos: [1280, 800],
};

const T = {
  lilac: ['#2c2442', '#d4c6ff'],
  mint: ['#173328', '#9fe3c2'],
  salmon: ['#3a2817', '#f8c38f'],
  blue: ['#1b2a42', '#a9c6f5'],
  pink: ['#3a1f29', '#f5b3c6'],
} as const;
type Tone = keyof typeof T;

const chip = (tone: Tone, text: string) =>
  `<span class="lps-chip" style="background:${T[tone][0]};color:${T[tone][1]}">${text}</span>`;
const d = (i: number, step = 0.35) =>
  `animation-delay:${(i * step).toFixed(2)}s;`;
const ia = (time: string) =>
  `<div class="lps-meta"><span style="color:#d4c6ff;font-weight:700">IA</span> · ${time}</div>`;

const mobileHead = `<div style="height:54px"></div>`;

// ---------------------------------------------------------------- mobile
function conversaM() {
  return `<div class="lps-scr lps-scr-m">${mobileHead}
  <div class="lps-row" style="padding:8px 14px 12px;border-bottom:1px solid #2f2d37;gap:10px">
    <span class="lps-av" style="background:#9fd8bd">LF</span>
    <span class="lps-col" style="flex-grow:1"><b style="font-size:15px">Lucas Ferreira</b><span class="lps-mut" style="font-size:11.5px">+55 85 9 8812-4471</span></span>
    ${chip('lilac', 'Aberta')}
  </div>
  <div class="lps-col" style="flex-grow:1;padding:14px 12px;gap:8px;overflow:hidden">
    <span class="lps-day">Hoje</span>
    <div class="lps-in lps-b-out">E aí, Lucas! Aqui é o assistente virtual da Barbearia Navalha. Bora dar um trato no visual essa semana?${ia('10:46')}</div>
    <div class="lps-in lps-b-in" style="${d(2)}">Bora! Tô precisando de corte e barba<div class="lps-meta">10:47</div></div>
    <div class="lps-in lps-b-out" style="${d(4)}">Show! Pro combo corte + barba ainda tenho amanhã:
      <div class="lps-slots"><span>09:30</span><span class="lps-glow lps-slot-on" style="${d(4)}">14:00</span><span>16:30</span></div>${ia('10:47')}</div>
    <div class="lps-in lps-b-in" style="${d(7)}">14h fechado<div class="lps-meta">10:48</div></div>
    <div class="lps-in lps-sys" style="${d(9)}">Agendado pela IA · qua 14:00 · corte + barba</div>
    <div class="lps-in lps-typing" style="${d(11)}"><span class="lps-dot"></span><span class="lps-dot" style="animation-delay:.15s"></span><span class="lps-dot" style="animation-delay:.3s"></span></div>
  </div>
  <div class="lps-row" style="padding:8px 12px;border-top:1px solid #2f2d37;justify-content:space-between;font-size:12px;color:#d4c6ff;font-weight:700">
    <span>O assistente de IA está respondendo</span><span class="lps-pill-dark">Assumir</span>
  </div>
  <div class="lps-row" style="padding:8px 12px 30px;gap:8px">
    <span class="lps-composer" style="flex-grow:1">Digite uma mensagem…</span>
  </div>
</div>`;
}

function prospecM() {
  const lead = (
    i: number,
    name: string,
    niche: string,
    status: string,
    tone: Tone
  ) =>
    `<div class="lps-in lps-card lps-row" style="${d(i + 1)}justify-content:space-between;padding:11px 12px;border-radius:16px">
      <span class="lps-col" style="gap:2px;min-width:0"><b style="font-size:13.5px">${name}</b><span class="lps-mut" style="font-size:11.5px">${niche}</span></span>${chip(tone, status)}</div>`;
  const bar = (
    label: string,
    val: string,
    w: number,
    color: string,
    i: number
  ) =>
    `<div><div class="lps-row" style="justify-content:space-between"><span>${label}</span><b>${val}</b></div>
      <div class="lps-track" style="margin-top:4px"><div class="lps-bar" style="${d(i, 0.4)}width:${w}%;background:${color}"></div></div></div>`;
  return `<div class="lps-scr lps-scr-m lps-col" style="gap:12px;padding:64px 16px 24px">
  <span style="font-size:26px;font-weight:800;letter-spacing:-0.02em">Prospecção</span>
  <div class="lps-grid2"><div class="lps-card" style="padding:12px"><div class="lps-mut" style="font-size:11.5px">Abordados</div><div class="lps-num">45</div></div>
    <div class="lps-card" style="padding:12px"><div class="lps-mut" style="font-size:11.5px">Taxa de resposta</div><div class="lps-num">24%</div></div></div>
  <div class="lps-in lps-card lps-col" style="padding:14px;gap:10px;border-radius:22px">
    <div class="lps-row" style="gap:8px"><b style="flex-grow:1">Revendas · Fortaleza</b>${chip('salmon', 'Em andamento')}</div>
    <span class="lps-mut" style="font-size:12px">Número oficial · abertura_revendas · 107 leads</span>
    <div class="lps-col" style="gap:8px;font-size:12px">
      ${bar('Abordados', '45 · 42%', 42, '#9ab7ea', 0)}${bar('Responderam', '11 · 24%', 24, '#ef9d7f', 1)}${bar('Qualificados', '4 · 9%', 9, '#9fd8bd', 2)}
    </div>
  </div>
  <span class="lps-mut" style="font-size:13px;font-weight:700;margin-top:4px">Leads</span>
  ${lead(0, 'Ricardo Veículos', 'Revenda de usados · nota 3.8', 'Qualificado', 'mint')}
  ${lead(1, 'Viasul Jeep Dunas', 'Concessionária · nota 4.5', 'Respondeu', 'salmon')}
  ${lead(2, 'Moto Center Aldeota', 'Loja de motos · nota 4.2', 'Abordado', 'blue')}
  ${lead(3, 'Auto Prime', 'Revenda de usados · nota 4.0', 'Abordado', 'blue')}
  ${lead(4, 'JL Multimarcas', 'Revenda de usados · nota 4.7', 'Na fila', 'lilac')}
</div>`;
}

function agendaM() {
  const days = [
    ['Ter', '6'],
    ['Qua', '7'],
    ['Qui', '8'],
    ['Sex', '9'],
    ['Sáb', '10'],
  ]
    .map(
      ([wd, n]) =>
        `<span class="lps-daychip${n === '7' ? ' lps-daychip-on' : ''}"><span style="font-size:11px">${wd}</span><b style="font-size:17px">${n}</b></span>`
    )
    .join('');
  const appt = (
    i: number,
    time: string,
    name: string,
    svc: string,
    ai: boolean
  ) =>
    `<div class="lps-in lps-card lps-row" style="${d(i, 0.4)}gap:10px;padding:12px;border-radius:18px">
      <span style="width:52px;flex-shrink:0;font-weight:800;font-size:15px">${time}</span>
      <span style="width:4px;align-self:stretch;border-radius:999px;background:${ai ? '#9fd8bd' : '#b9a2f2'}"></span>
      <span class="lps-col" style="gap:2px;flex-grow:1;min-width:0"><b style="font-size:14px">${name}</b><span class="lps-mut" style="font-size:12px">${svc}</span></span>
      ${chip(ai ? 'mint' : 'lilac', ai ? 'IA' : 'Equipe')}</div>`;
  return `<div class="lps-scr lps-scr-m lps-col" style="gap:12px;padding:64px 16px 24px">
  <div class="lps-row" style="justify-content:space-between"><span style="font-size:26px;font-weight:800;letter-spacing:-0.02em">Agenda</span><span class="lps-pill-light">+ Novo</span></div>
  <div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px">${days}</div>
  <span class="lps-mut" style="font-size:13px;font-weight:600">Quarta, 7 de outubro · 6 horários</span>
  ${appt(0, '09:30', 'Pedro Rocha', 'Barba · com o Rafa', true)}
  ${appt(1, '10:30', 'Bruno Costa', 'Pacote noivo', false)}
  ${appt(2, '11:15', 'Diego Melo', 'Corte', true)}
  ${appt(3, '14:00', 'Lucas Ferreira', 'Corte + barba · com o Rafa', true)}
  ${appt(4, '15:30', 'Ana Lima', 'Sobrancelha', false)}
  ${appt(5, '17:00', 'Carlos Mendes', 'Corte', true)}
</div>`;
}

// ---------------------------------------------------------------- desktop
const NAV_ICONS: Record<string, string> = {
  painel: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  inbox: 'M4 5h16v11H9l-5 4z',
  casos: 'M5 4h14v16H5zM9 9h6M9 13h6',
  notif: 'M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20h4',
  contatos: 'M8 11a3 3 0 100-6 3 3 0 000 6zM2 20a6 6 0 0112 0',
  negocios: 'M6 3v12a3 3 0 003 3h9M6 8a2 2 0 100-4M18 21a2 2 0 100-4',
  prospec: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8z',
  agenda: 'M4 6h16v14H4zM8 3v4M16 3v4M4 11h16',
  agentes: 'M12 3v3M5 9h14v10H5zM9 14h.01M15 14h.01',
  auto: 'M13 3L5 14h6l-1 7 8-11h-6z',
  fluxos: 'M6 4v6a4 4 0 004 4h8M14 10l4 4-4 4',
  disparos:
    'M7 7a7 7 0 000 10M17 7a7 7 0 010 10M12 10a2 2 0 110 4 2 2 0 010-4z',
};
const NAV: [string, string][] = [
  ['g', 'Atendimento'],
  ['painel', 'Painel'],
  ['inbox', 'Caixa de entrada'],
  ['casos', 'Casos'],
  ['notif', 'Notificações'],
  ['g', 'CRM'],
  ['contatos', 'Contatos'],
  ['negocios', 'Negócios'],
  ['prospec', 'Prospecção'],
  ['agenda', 'Agenda'],
  ['g', 'Agente de IA'],
  ['agentes', 'Agentes de IA'],
  ['auto', 'Automações'],
  ['fluxos', 'Fluxos'],
  ['g', 'Canais'],
  ['disparos', 'Disparos'],
];

function shell(active: string, main: string) {
  const nav = NAV.map(([k, label]) =>
    k === 'g'
      ? `<span class="lps-snavg">${label}</span>`
      : `<span class="lps-snav${k === active ? ' lps-snav-on' : ''}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${NAV_ICONS[k]}"/></svg>${label}</span>`
  ).join('');
  return `<div class="lps-scr lps-scr-d">
  <aside class="lps-side">
    <div class="lps-row" style="gap:10px;padding:0 6px 12px"><span class="lps-av" style="width:34px;height:34px;border-radius:10px;background:#b9a2f2">B</span><b style="font-size:15px">Barbearia Navalha</b></div>
    ${nav}
    <div class="lps-row" style="margin-top:auto;gap:10px;padding:10px 6px 0;border-top:1px solid #2f2d37"><span class="lps-av" style="width:32px;height:32px;background:#ef9d7f">RS</span><span class="lps-col"><b>Rafa Souza</b><span class="lps-mut" style="font-size:11px">Administrador</span></span></div>
  </aside>
  <main class="lps-main">${main}</main>
</div>`;
}

const title = (t: string) =>
  `<b style="font-size:28px;letter-spacing:-0.02em">${t}</b>`;
const stat = (label: string, value: string, bg?: string) =>
  bg
    ? `<div style="background:${bg};color:#1d1b18;border-radius:18px;padding:12px"><div style="font-size:12px;font-weight:600">${label}</div><div style="font-size:22px;font-weight:800">${value}</div></div>`
    : `<div class="lps-card" style="padding:12px;border-radius:18px"><div class="lps-mut" style="font-size:12px">${label}</div><div style="font-size:22px;font-weight:800">${value}</div></div>`;

function inbox() {
  const conv = (
    i: number,
    ini: string,
    bg: string,
    name: string,
    when: string,
    last: string,
    tag: string,
    tone: Tone,
    on = false
  ) =>
    `<div class="lps-in lps-row" style="${d(i, 0.25)}gap:10px;padding:10px;border-radius:16px;align-items:flex-start;${on ? 'background:#24232b;' : ''}">
      <span class="lps-av" style="width:40px;height:40px;background:${bg}">${ini}</span>
      <span class="lps-col" style="gap:3px;min-width:0;flex-grow:1"><span class="lps-row" style="justify-content:space-between"><b>${name}</b><span class="lps-mut" style="font-size:11px">${when}</span></span>
      <span class="lps-mut lps-ell" style="font-size:12px">${last}</span>${chip(tone, tag)}</span></div>`;
  const out = (i: number, text: string, time: string) =>
    `<div class="lps-in lps-b-out" style="${d(i, 0.7)}max-width:62%">${text}${ia(time)}</div>`;
  const inn = (i: number, text: string, time: string) =>
    `<div class="lps-in lps-b-in" style="${d(i, 0.7)}max-width:62%">${text}<div class="lps-meta">${time}</div></div>`;
  return shell(
    'inbox',
    `<div class="lps-row" style="gap:14px;height:772px;margin:-10px -8px 0;align-items:stretch">
    <section class="lps-card lps-col" style="width:280px;flex-shrink:0;border-radius:24px;padding:16px 12px;gap:10px">
      <b style="font-size:22px;letter-spacing:-0.02em;padding:0 4px">Caixa de entrada</b>
      <div class="lps-row" style="gap:6px;flex-wrap:wrap"><span class="lps-ghost">Responder</span><span class="lps-ghost">Aguardando <b>2</b></span><span class="lps-ghost">Agendadas</span></div>
      <span class="lps-composer">Buscar conversas…</span>
      ${conv(0, 'LF', '#9fd8bd', 'Lucas Ferreira', '10:48', 'Fechado! Quarta 14h com o Rafa…', 'IA · agendado', 'mint', true)}
      ${conv(1, 'JP', '#ef9d7f', 'João Pedro', 'há 12 min', 'Vocês fazem pigmentação de barba?', 'Precisa de você', 'salmon')}
      ${conv(2, 'MC', '#b9a2f2', 'Marcos Costa', '10:31', 'Quanto fica o pacote do noivo?', 'IA atendendo', 'lilac')}
      ${conv(3, 'TF', '#9ab7ea', 'Thiago Freitas', 'ontem', 'Modelo · lembrete do seu horário', 'Agendado', 'blue')}
      ${conv(4, 'AL', '#f5b3c6', 'Ana Lima', 'ontem', 'Obrigada! Até sábado', 'Resolvida', 'pink')}
    </section>
    <section class="lps-card lps-col" style="flex-grow:1;min-width:0;border-radius:24px;overflow:hidden">
      <div class="lps-row" style="gap:10px;padding:12px 16px;border-bottom:1px solid #2f2d37"><span class="lps-av" style="width:38px;height:38px;background:#9fd8bd">LF</span><span class="lps-col" style="flex-grow:1"><b style="font-size:15px">Lucas Ferreira</b><span class="lps-mut" style="font-size:11.5px">+55 85 9 8812-4471</span></span><span style="color:#d4c6ff;font-weight:700">Aberta</span></div>
      <div class="lps-col" style="flex-grow:1;padding:16px 20px;gap:9px;overflow:hidden;font-size:13.5px">
        ${out(0, 'E aí, Lucas! Aqui é o assistente virtual da Barbearia Navalha. Bora dar um trato no visual essa semana?', '10:46')}
        ${inn(1, 'Bora! Tô precisando de corte e barba, tem amanhã?', '10:47')}
        ${out(2, 'Tenho 09:30, 14:00 e 16:30 com o Rafa. Qual fica melhor?', '10:47')}
        ${inn(3, '14h fechado', '10:48')}
        <div class="lps-in lps-sys" style="${d(4, 0.7)}">Agendado pela IA · qua 14:00 · corte + barba</div>
        ${out(5, 'Fechado! Quarta 14h com o Rafa. Te mando um lembrete 1h antes.', '10:48')}
      </div>
      <div class="lps-row" style="padding:8px 16px;justify-content:space-between;color:#d4c6ff;font-weight:700;border-top:1px solid #2f2d37"><span>O assistente de IA está respondendo automaticamente</span><span style="color:#f2f0ec">Assumir</span></div>
      <div style="padding:8px 16px 14px"><span class="lps-composer" style="display:block">Digite uma mensagem…<span class="lps-cursor">|</span></span></div>
    </section>
    <aside class="lps-col" style="width:230px;flex-shrink:0;gap:12px">
      <div class="lps-card lps-col" style="border-radius:24px;padding:18px;align-items:center;gap:6px"><span class="lps-av" style="width:56px;height:56px;font-size:18px;background:#9fd8bd">LF</span><b style="font-size:15px">Lucas Ferreira</b>${chip('mint', 'cliente fiel')}</div>
      <div class="lps-in" style="${d(4, 0.7)}background:#b9a2f2;color:#1d1b18;border-radius:22px;padding:14px"><b style="font-size:12px">Próximo passo</b><div style="margin-top:4px;line-height:1.45">Atendimento qua 14:00. Lembrete automático 1h antes.</div></div>
      <div class="lps-card" style="border-radius:22px;padding:14px;line-height:1.5"><b class="lps-mut" style="font-size:12px">Resumo da IA</b><div style="margin-top:4px">Corta a cada 4 semanas, prefere tarde. Pediu corte + barba com o Rafa.</div></div>
      <div class="lps-card" style="border-radius:22px;padding:14px"><b class="lps-mut" style="font-size:12px">Negócios</b><div class="lps-row" style="justify-content:space-between;margin-top:6px"><span>Corte + barba</span><b>R$ 70</b></div></div>
    </aside>
  </div>`
  );
}

function prospec() {
  const bar = (w: number, color: string, delay: number) =>
    `<span class="lps-track" style="display:block;height:7px;margin-top:5px"><span class="lps-bar" style="${d(delay, 0.5)}display:block;width:${w}%;height:7px;background:${color}"></span></span>`;
  const camp = (
    i: number,
    name: string,
    status: string,
    tone: Tone,
    meta: string,
    leads: number,
    a: [number, number],
    r: [number, number],
    q: [number, number],
    foot: string
  ) =>
    `<div class="lps-in lps-card lps-col" style="${d(i, 0.5)}border-radius:22px;padding:16px;gap:12px">
      <div class="lps-row" style="gap:10px"><span class="lps-av" style="width:36px;height:36px;border-radius:12px;background:#2c2442;color:#d4c6ff">◎</span><span class="lps-col" style="flex-grow:1"><span class="lps-row" style="gap:8px"><b style="font-size:15px">${name}</b>${chip(tone, status)}</span><span class="lps-mut" style="font-size:12px">${meta}</span></span></div>
      <div style="display:grid;grid-template-columns:50px repeat(3,minmax(0,1fr));gap:14px;align-items:end">
        <span><span class="lps-mut" style="font-size:11.5px">Leads</span><br><b style="font-size:18px">${leads}</b></span>
        <span><span class="lps-row" style="justify-content:space-between;font-size:11.5px"><span class="lps-mut">Abordados</span><b>${a[0]} · ${a[1]}%</b></span>${bar(a[1], '#9ab7ea', i)}</span>
        <span><span class="lps-row" style="justify-content:space-between;font-size:11.5px"><span class="lps-mut">Responderam</span><b>${r[0]} · ${r[1]}%</b></span>${bar(r[1], '#ef9d7f', i + 0.6)}</span>
        <span><span class="lps-row" style="justify-content:space-between;font-size:11.5px"><span class="lps-mut">Qualificados</span><b>${q[0]} · ${q[1]}%</b></span>${bar(q[1], '#9fd8bd', i + 1.2)}</span>
      </div>
      <span class="lps-mut" style="font-size:12px">${foot}</span></div>`;
  return shell(
    'prospec',
    `<div class="lps-row" style="justify-content:space-between">${title('Prospecção')}<span class="lps-pill-light">+ Nova campanha</span></div>
    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px">${stat('Campanhas ativas', '2')}${stat('Abordados', '152')}${stat('Taxa de resposta', '22%')}${stat('Qualificados', '9')}</div>
    ${camp(0, 'Revendas de veículos · Fortaleza', 'Em andamento', 'salmon', 'Número oficial · abertura_revendas · 06/10/2026', 107, [45, 42], [11, 24], [4, 9], '62 na fila · 0 com falha · 9 pulados · 1 pediu para sair')}
    ${camp(1, 'Clínicas de estética · Aldeota', 'Em andamento', 'salmon', 'Número próprio · dia 3 do aquecimento · próximo envio 14:32', 64, [22, 34], [6, 27], [2, 9], '42 na fila · 0 com falha · 3 pulados · 0 pediram para sair')}
    ${camp(2, 'Academias · Meireles', 'Concluída', 'mint', 'Número oficial · abertura_academias · 28/09/2026', 85, [85, 100], [17, 20], [3, 4], '0 na fila · 2 com falha · 5 pulados · 2 pediram para sair')}`
  );
}

function negocios() {
  const card = (
    name: string,
    text: string,
    tag: string,
    tone: Tone,
    when: string,
    value: string,
    mover = false
  ) =>
    `<div class="${mover ? 'lps-move' : 'lps-in'}" style="${mover ? 'position:relative;z-index:2;background:#2c2442;border:1px solid #b9a2f2;' : 'background:#24232b;'}border-radius:16px;padding:10px;display:flex;flex-direction:column;gap:6px">
      ${chip(tone, tag)}<b>${name}</b><span class="lps-mut" style="font-size:12px">${text}</span>
      <span class="lps-row" style="justify-content:space-between;border-top:1px solid #2f2d37;padding-top:7px;font-size:12px"><span class="lps-mut">${when}</span><b>${value}</b></span></div>`;
  const col = (t: string, n: number, dot: string, cards: string) =>
    `<div class="lps-card lps-col" style="border-radius:20px;padding:12px;gap:8px;min-height:390px"><span class="lps-row" style="gap:8px;font-weight:700"><span style="width:9px;height:9px;border-radius:999px;background:${dot}"></span>${t} <span class="lps-mut" style="font-weight:500">(${n})</span></span>${cards}</div>`;
  return shell(
    'negocios',
    `${title('Negócios')}
    <div class="lps-row" style="justify-content:space-between"><span class="lps-ghost">Pipeline de vendas</span><span class="lps-pill-light">+ Adicionar negócio</span></div>
    <div style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px">${stat('Total de negócios', '14')}${stat('Valor do pipeline', 'R$ 3.480', '#b9a2f2')}${stat('Ticket médio', 'R$ 248')}${stat('Valor ponderado', 'R$ 1.920', '#9ab7ea')}${stat('Ganhos neste mês', '8', '#9fd8bd')}${stat('Perdidos neste mês', '1', '#ef9d7f')}</div>
    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;align-items:start">
      ${col('Novo lead', 4, '#9ab7ea', card('João Pedro', 'Pigmentação de barba', 'Precisa de você', 'salmon', 'há 12 min', 'R$ 90') + card('Marcos Costa', 'Pacote noivo · 3 pessoas', 'IA', 'mint', 'há 1 h', 'R$ 360'))}
      ${col('Qualificado', 3, '#f2c94c', card('Lucas Ferreira', 'Corte + barba · qua 14:00', 'IA · agendado', 'mint', 'qua 14:00', 'R$ 70', true) + card('Diego Melo', 'Plano mensal', 'Rafa', 'lilac', 'ontem', 'R$ 180'))}
      ${col('Proposta enviada', 2, '#ef9d7f', card('Studio Bela', 'Parceria · 10 cortes/mês', 'follow-up em 2 dias', 'salmon', 'seg', 'R$ 650'))}
      ${col('Negociação', 1, '#b9a2f2', card('Ana Lima', 'Assinatura 4 cortes', 'Caso aberto', 'pink', 'há 2 h', 'R$ 160/mês'))}
    </div>`
  );
}

function agenda() {
  const HH = 50;
  let k = 0;
  const ev = (
    start: string,
    dur: number,
    name: string,
    info: string,
    ai: boolean
  ) => {
    const [h, m] = start.split(':').map(Number);
    return `<span class="lps-in" style="${d(k++, 0.3)}position:absolute;left:4px;right:4px;top:${(h - 9) * HH + (m / 60) * HH}px;height:${(dur / 60) * HH - 4}px;box-sizing:border-box;border-radius:12px;padding:5px 8px;font-size:11.5px;line-height:1.3;color:#1d1b18;background:${ai ? '#9fd8bd' : '#b9a2f2'}"><b>${name}</b><br>${start} · ${info}</span>`;
  };
  const days: [string, string, boolean, string][] = [
    [
      'Ter',
      '6',
      true,
      ev('10:00', 45, 'Rafael A.', 'corte', true) +
        ev('15:00', 60, 'Bruno C.', 'noivo', false),
    ],
    [
      'Qua',
      '7',
      false,
      ev('09:30', 45, 'Pedro R.', 'barba', true) +
        ev('14:00', 60, 'Lucas F.', 'corte + barba', true),
    ],
    [
      'Qui',
      '8',
      false,
      ev('11:00', 45, 'Ana L.', 'corte', false) +
        ev('16:30', 45, 'Diego M.', 'corte', true),
    ],
    ['Sex', '9', false, ev('13:00', 45, 'Marcos C.', 'barba', false)],
    [
      'Sáb',
      '10',
      false,
      ev('09:00', 45, 'Thiago F.', 'corte', true) +
        ev('10:30', 60, 'Carlos M.', 'corte + barba', true),
    ],
  ];
  const head = days
    .map(
      ([wd, n, today]) =>
        `<span class="lps-mut" style="text-align:center;padding:6px 0;font-size:12px">${wd}<br><b style="display:inline-block;margin-top:3px;${today ? 'border-radius:999px;padding:1px 8px;background:#f2f0ec;color:#16151a' : 'color:#f2f0ec'}">${n}</b></span>`
    )
    .join('');
  const hours = [
    '09:00',
    '10:00',
    '11:00',
    '12:00',
    '13:00',
    '14:00',
    '15:00',
    '16:00',
    '17:00',
  ]
    .map(
      (h) =>
        `<span class="lps-mut" style="height:${HH}px;font-size:11px">${h}</span>`
    )
    .join('');
  const cols = days
    .map(
      ([, , , evs]) =>
        `<span style="position:relative;height:450px;border-left:1px solid #2f2d37">${evs}</span>`
    )
    .join('');
  const next = [
    ['Lucas Ferreira', 'qua 14:00 · corte + barba'],
    ['Pedro Rocha', 'qua 09:30 · barba'],
    ['Ana Lima', 'qui 11:00 · corte'],
    ['Carlos Mendes', 'sáb 10:30 · corte + barba'],
  ]
    .map(
      ([n, i], j) =>
        `<span class="lps-in lps-col" style="${d(j, 0.4)}gap:2px;padding:9px 10px;border-radius:14px;background:#24232b"><b>${n}</b><span class="lps-mut" style="font-size:12px">${i}</span></span>`
    )
    .join('');
  return shell(
    'agenda',
    `${title('Agenda')}
    <div class="lps-row" style="gap:8px"><span class="lps-ghost">‹</span><span class="lps-ghost">Hoje</span><span class="lps-ghost">›</span><span class="lps-mut">6 – 10 de out.</span><span class="lps-pill-light" style="margin-left:auto">Semana</span><span class="lps-pill-light">+ Novo agendamento</span></div>
    <div class="lps-row" style="gap:12px;align-items:flex-start">
      <div class="lps-card" style="flex-grow:1;border-radius:22px;padding:10px;display:grid;grid-template-columns:50px repeat(5,minmax(0,1fr))"><span></span>${head}<span class="lps-col">${hours}</span>${cols}</div>
      <div class="lps-card lps-col" style="width:230px;flex-shrink:0;border-radius:22px;padding:14px;gap:10px"><b class="lps-mut" style="font-size:12px">Próximos da semana</b>${next}</div>
    </div>`
  );
}

function disparos() {
  const blast = (
    i: number,
    name: string,
    tpl: string,
    date: string,
    n: string,
    del: number,
    read: number
  ) =>
    `<div class="lps-in lps-card lps-col" style="${d(i, 0.4)}border-radius:20px;padding:14px;gap:12px">
      <div class="lps-row" style="gap:10px"><span class="lps-av" style="width:34px;height:34px;background:#2c2442;color:#d4c6ff">⦿</span><span class="lps-col" style="flex-grow:1"><b style="font-size:14px">${name}</b><span class="lps-mut" style="font-size:11.5px">${tpl}</span></span><span class="lps-col" style="align-items:flex-end;gap:3px">${chip('mint', 'Enviado')}<span class="lps-mut" style="font-size:11px">${date}</span></span></div>
      <div style="display:grid;grid-template-columns:70px repeat(2,minmax(0,1fr));gap:12px;align-items:end"><span><span class="lps-mut" style="font-size:11px">Destinatários</span><br><b>${n}</b></span>
        <span><span class="lps-row" style="justify-content:space-between;font-size:11px"><span>Entrega</span><b>${del}%</b></span><span class="lps-track" style="display:block;margin-top:4px"><span class="lps-bar" style="${d(i, 0.4)}display:block;width:${del}%;background:#9fd8bd"></span></span></span>
        <span><span class="lps-row" style="justify-content:space-between;font-size:11px"><span>Lidas</span><b>${read}%</b></span><span class="lps-track" style="display:block;margin-top:4px"><span class="lps-bar" style="${d(i + 0.5, 0.4)}display:block;width:${read}%;background:#9ab7ea"></span></span></span></div></div>`;
  return shell(
    'disparos',
    `<div class="lps-row" style="justify-content:space-between"><span>${title('Disparos')}<br><span class="lps-mut">Envie mensagens em massa para seus contatos usando modelos aprovados.</span></span><span class="lps-pill-light">+ Novo disparo</span></div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px">${stat('Disparos', '12')}${stat('Destinatários', '3.412')}${stat('Taxa de leitura', '81%')}</div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
      ${blast(0, 'Promo de outubro', 'promo_outubro_v2', '06/10/2026', '1.240', 98, 84)}
      ${blast(1, 'Lembrete de retorno', 'lembrete_retorno', '04/10/2026', '382', 100, 91)}
      ${blast(2, 'Clientes sumidos', 'saudade_cliente', '01/10/2026', '214', 97, 76)}
      ${blast(3, 'Dia dos Pais', 'dia_dos_pais_combo', '08/08/2026', '1.576', 99, 79)}
    </div>`
  );
}

const BUILDERS: Record<ScreenId, () => string> = {
  conversaM,
  prospecM,
  agendaM,
  inbox,
  prospec,
  negocios,
  agenda,
  disparos,
};

const cache = new Map<ScreenId, string>();
export function screenHtml(id: ScreenId): string {
  let html = cache.get(id);
  if (!html) {
    html = BUILDERS[id]();
    cache.set(id, html);
  }
  return html;
}
