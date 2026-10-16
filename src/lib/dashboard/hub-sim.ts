import type { RoomId, RoomMemberInput } from './room';

/**
 * The scripted day for /hub?demo=1: customers arrive on WhatsApp, the AI
 * greets them at reception and either answers alone or hands them to a
 * person, who serves, negotiates, schedules or wins. Pure: the state at
 * any second comes from folding the script up to that second, so the TV
 * and the tests see the same thing. The script loops every LOOP seconds.
 */

export const LOOP = 75;

/** A customer in the room; 'out' walks off the stage before going away. */
export interface Visitor {
  id: string;
  name: string;
  look: number;
  room: RoomId | 'out';
  /** i18n key under Hub.sim.say, shown as a speech bubble. */
  say?: string;
}

export type SimKind =
  | 'enter'
  | 'ai'
  | 'triage'
  | 'handoff'
  | 'reply'
  | 'deal'
  | 'schedule'
  | 'won'
  | 'solved'
  | 'leave'
  | 'away'
  | 'back'
  | 'desk';

export interface SimEvent {
  at: number;
  kind: SimKind;
  /** Customer id (visitor). */
  to?: string;
  /** Team member id. */
  agent?: string;
  /** enter: Hub.sim.say key; ai: Hub.sim.aiSay key. */
  line?: string;
  value?: number;
}

export interface LogLine {
  /** Seconds since the simulation started. */
  at: number;
  kind: SimKind;
  name?: string;
  agent?: string;
  line?: string;
  value?: number;
}

export interface SimState {
  team: RoomMemberInput[];
  visitors: Visitor[];
  queue: number;
  aiReplies: number;
  /** Hub.sim.aiSay key the AI is saying at the counter, if any. */
  aiSay?: string;
  /** Newest first. */
  log: LogLine[];
}

const member = (
  userId: string,
  name: string,
  role: string,
  look: number
): RoomMemberInput => ({
  userId,
  name,
  role,
  look,
  presence: 'online',
  waiting: 0,
  late: false,
  justWon: false,
  negotiating: false,
});

export const SIM_TEAM: RoomMemberInput[] = [
  member('sim-ana', 'Ana Souza', 'owner', 2),
  member('sim-bruno', 'Bruno Lima', 'agent', 1),
  member('sim-carla', 'Carla Dias', 'agent', 3),
  member('sim-diego', 'Diego Rocha', 'agent', 4),
  member('sim-gabi', 'Gabi Torres', 'agent', 5),
  member('sim-hugo', 'Hugo Melo', 'agent', 6),
];

export const SIM_CUSTOMERS: Record<string, { name: string; look: number }> = {
  marina: { name: 'Marina', look: 5 },
  paulo: { name: 'Paulo', look: 6 },
  julia: { name: 'Júlia', look: 3 },
  rafael: { name: 'Rafael', look: 1 },
};

export const SIM_SCRIPT: SimEvent[] = [
  { at: 1, kind: 'away', agent: 'sim-gabi' },
  { at: 2, kind: 'enter', to: 'marina', line: 'install' },
  { at: 5, kind: 'ai', to: 'marina', line: 'hello' },
  { at: 9, kind: 'triage', to: 'marina' },
  {
    at: 12,
    kind: 'handoff',
    to: 'marina',
    agent: 'sim-bruno',
    line: 'handoff',
  },
  { at: 15, kind: 'enter', to: 'paulo', line: 'quote' },
  { at: 18, kind: 'ai', to: 'paulo', line: 'hello' },
  { at: 21, kind: 'reply', to: 'marina', agent: 'sim-bruno' },
  { at: 24, kind: 'deal', to: 'paulo', agent: 'sim-carla', value: 4800 },
  { at: 28, kind: 'enter', to: 'julia', line: 'hours' },
  { at: 31, kind: 'ai', to: 'julia', line: 'hours' },
  { at: 33, kind: 'solved', to: 'julia' },
  { at: 35, kind: 'schedule', to: 'marina', agent: 'sim-bruno' },
  { at: 37, kind: 'leave', to: 'julia' },
  { at: 38, kind: 'back', agent: 'sim-gabi' },
  { at: 40, kind: 'leave', to: 'marina' },
  { at: 42, kind: 'enter', to: 'rafael', line: 'problem' },
  { at: 45, kind: 'ai', to: 'rafael', line: 'handoff' },
  { at: 47, kind: 'handoff', to: 'rafael', agent: 'sim-diego' },
  { at: 50, kind: 'won', to: 'paulo', agent: 'sim-carla', value: 4800 },
  { at: 54, kind: 'leave', to: 'paulo' },
  { at: 57, kind: 'reply', to: 'rafael', agent: 'sim-diego' },
  { at: 62, kind: 'desk', agent: 'sim-carla' },
  { at: 64, kind: 'leave', to: 'rafael' },
];

/** How long a speech bubble stays up, and a leaver stays on stage. */
const SAY_S = 4;
const LEAVE_S = 7;
const LOG_SIZE = 8;
const AI_BASE = 36;

function fold(t: number): Omit<SimState, 'log'> {
  const team = new Map(SIM_TEAM.map((m) => [m.userId, { ...m }]));
  const visitors = new Map<
    string,
    Visitor & { sayAt: number; leftAt?: number }
  >();
  let aiReplies = AI_BASE;
  let aiSay: string | undefined;
  let aiAt = -Infinity;
  for (const e of SIM_SCRIPT) {
    if (e.at > t) break;
    const v = e.to ? visitors.get(e.to) : undefined;
    const a = e.agent ? team.get(e.agent) : undefined;
    switch (e.kind) {
      case 'enter': {
        const c = SIM_CUSTOMERS[e.to!];
        visitors.set(e.to!, {
          id: `sim-c-${e.to}`,
          name: c.name,
          look: c.look,
          room: 'recepcao',
          say: e.line,
          sayAt: e.at,
        });
        break;
      }
      case 'ai':
        aiReplies++;
        aiSay = e.line;
        aiAt = e.at;
        break;
      case 'solved':
        aiReplies++;
        break;
      case 'handoff':
        if (v) v.room = 'atendimento';
        if (a) a.waiting++;
        break;
      case 'reply':
        if (a) a.waiting = Math.max(0, a.waiting - 1);
        break;
      case 'deal':
        if (v) v.room = 'negociacao';
        if (a) a.negotiating = true;
        break;
      case 'won':
        if (a) Object.assign(a, { negotiating: false, justWon: true });
        break;
      case 'desk':
        if (a) Object.assign(a, { negotiating: false, justWon: false });
        break;
      case 'leave':
        if (v) Object.assign(v, { room: 'out', leftAt: e.at });
        break;
      case 'away':
        if (a) a.presence = 'away';
        break;
      case 'back':
        if (a) a.presence = 'online';
        break;
    }
  }
  const shown = [...visitors.values()]
    .filter((v) => v.leftAt === undefined || t - v.leftAt < LEAVE_S)
    .map((v) => ({
      id: v.id,
      name: v.name,
      look: v.look,
      room: v.room,
      say: t - v.sayAt < SAY_S ? v.say : undefined,
    }));
  return {
    team: [...team.values()],
    visitors: shown,
    queue: shown.filter((v) => v.room === 'recepcao').length,
    aiReplies,
    aiSay: t - aiAt < SAY_S ? aiSay : undefined,
  };
}

function logLine(e: SimEvent, at: number): LogLine {
  return {
    at,
    kind: e.kind,
    name: e.to ? SIM_CUSTOMERS[e.to]?.name : undefined,
    agent: e.agent
      ? SIM_TEAM.find((m) => m.userId === e.agent)?.name.split(' ')[0]
      : undefined,
    line: e.kind === 'enter' ? e.line : undefined,
    value: e.value,
  };
}

/** The room and the log `elapsed` seconds into the simulation. */
export function simAt(elapsed: number): SimState {
  const loop = Math.floor(elapsed / LOOP);
  const t = elapsed - loop * LOOP;
  const log: LogLine[] = [];
  for (let k = loop; k >= Math.max(0, loop - 1) && log.length < LOG_SIZE; k--) {
    const until = k === loop ? t : LOOP;
    for (const e of [...SIM_SCRIPT].reverse()) {
      if (e.at > until) continue;
      log.push(logLine(e, k * LOOP + e.at));
      if (log.length >= LOG_SIZE) break;
    }
  }
  return { ...fold(t), log };
}
