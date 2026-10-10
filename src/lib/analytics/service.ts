// Pure aggregation for the "Atendimento" report (migration 127): the rows
// come from service_leads / service_responses, every number on the page
// is computed here so it can be unit-tested without Supabase.

export type ReplyKind = 'ai' | 'human' | 'automation';

export interface LeadRow {
  conversation_id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  whatsapp_config_id: string | null;
  whatsapp_channel_id: string | null;
  arrived_at: string;
  first_reply_at: string | null;
  first_reply_kind: ReplyKind | null;
  first_reply_user_id: string | null;
  assigned_agent_id: string | null;
  status: string | null;
}

export interface ResponseRow {
  conversation_id: string;
  customer_at: string;
  replied_at: string;
  reply_kind: ReplyKind;
  reply_user_id: string | null;
}

const minutesBetween = (a: string, b: string) =>
  (new Date(b).getTime() - new Date(a).getTime()) / 60_000;

/** Minutes until the first reply; null when never answered. */
export function firstReplyMinutes(l: LeadRow): number | null {
  return l.first_reply_at ? Math.max(0, minutesBetween(l.arrived_at, l.first_reply_at)) : null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const pct = (part: number, total: number) => (total ? Math.round((part / total) * 100) : null);

export interface ServiceSummary {
  leads: number;
  answered: number;
  unanswered: number;
  medianFirstMinutes: number | null;
  avgFirstMinutes: number | null;
  /** Leads answered within the account's target, % of answered. */
  withinTargetPct: number | null;
  /** Leads whose first reply came from the AI, % of answered. */
  aiFirstPct: number | null;
}

export function summarize(leads: LeadRow[], targetMinutes: number): ServiceSummary {
  const times = leads.map(firstReplyMinutes).filter((m): m is number => m !== null);
  const ai = leads.filter((l) => l.first_reply_kind === 'ai').length;
  return {
    leads: leads.length,
    answered: times.length,
    unanswered: leads.length - times.length,
    medianFirstMinutes: median(times),
    avgFirstMinutes: avg(times),
    withinTargetPct: pct(times.filter((m) => m <= targetMinutes).length, times.length),
    aiFirstPct: pct(ai, times.length),
  };
}

/** YYYY-MM-DD in the viewer's local time. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface DayPoint {
  day: string;
  leads: number;
  /** Median minutes of replies that day, by who replied. */
  ai: number | null;
  human: number | null;
}

/** One point per day of the period (empty days included). */
export function byDay(
  leads: LeadRow[],
  responses: ResponseRow[],
  from: Date,
  to: Date
): DayPoint[] {
  const days: string[] = [];
  for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) {
    days.push(localDay(d.toISOString()));
  }
  const unique = [...new Set(days)];
  const leadsPer = new Map<string, number>();
  for (const l of leads) {
    const k = localDay(l.arrived_at);
    leadsPer.set(k, (leadsPer.get(k) ?? 0) + 1);
  }
  const times = new Map<string, { ai: number[]; human: number[] }>();
  for (const r of responses) {
    if (r.reply_kind === 'automation') continue;
    const k = localDay(r.replied_at);
    const bucket = times.get(k) ?? { ai: [], human: [] };
    bucket[r.reply_kind].push(minutesBetween(r.customer_at, r.replied_at));
    times.set(k, bucket);
  }
  return unique.map((day) => ({
    day,
    leads: leadsPer.get(day) ?? 0,
    ai: median(times.get(day)?.ai ?? []),
    human: median(times.get(day)?.human ?? []),
  }));
}

/** Leads per hour of the day (0–23, viewer's local time). */
export function arrivalsByHour(leads: LeadRow[]): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const l of leads) hours[new Date(l.arrived_at).getHours()]++;
  return hours;
}

export interface ResponderStats {
  /** user id for a person; 'ai' for the AI agents together. */
  key: string;
  kind: 'human' | 'ai';
  replies: number;
  medianMinutes: number | null;
  avgMinutes: number | null;
  withinTargetPct: number | null;
}

/** Per person (and the AI as one row), slowest median last. */
export function perResponder(responses: ResponseRow[], targetMinutes: number): ResponderStats[] {
  const groups = new Map<string, { kind: 'human' | 'ai'; t: number[] }>();
  for (const r of responses) {
    if (r.reply_kind === 'automation') continue;
    const key = r.reply_kind === 'ai' ? 'ai' : r.reply_user_id ?? 'unknown';
    const g = groups.get(key) ?? { kind: r.reply_kind === 'ai' ? 'ai' : 'human', t: [] };
    g.t.push(Math.max(0, minutesBetween(r.customer_at, r.replied_at)));
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      kind: g.kind,
      replies: g.t.length,
      medianMinutes: median(g.t),
      avgMinutes: avg(g.t),
      withinTargetPct: pct(g.t.filter((m) => m <= targetMinutes).length, g.t.length),
    }))
    .sort((a, b) => (a.medianMinutes ?? Infinity) - (b.medianMinutes ?? Infinity));
}

/** "45 s", "12 min", "3 h 10 min", "2 d 4 h". */
export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—';
  if (minutes < 1) return `${Math.round(minutes * 60)} s`;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  if (h < 24) {
    const m = Math.round(minutes - h * 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  const rh = h - d * 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of the leads table (header labels passed in, already translated). */
export function leadsCsv(
  leads: LeadRow[],
  headers: string[],
  labels: { kind: (k: ReplyKind | null) => string; who: (l: LeadRow) => string; number: (l: LeadRow) => string }
): string {
  const rows = leads.map((l) => [
    l.contact_name ?? '',
    l.contact_phone ?? '',
    labels.number(l),
    new Date(l.arrived_at).toLocaleString(),
    l.first_reply_at ? new Date(l.first_reply_at).toLocaleString() : '',
    l.first_reply_at ? Math.round(firstReplyMinutes(l)! * 10) / 10 : '',
    labels.kind(l.first_reply_kind),
    labels.who(l),
  ]);
  return [headers, ...rows].map((r) => r.map(csvCell).join(';')).join('\n');
}
