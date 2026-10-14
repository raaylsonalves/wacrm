// ScaLE partner API v1 — the barbershop booking system the AI can book
// into instead of wacrm's own calendar (migration 130). Flow, per their
// docs: units → services of a unit → professionals who do ALL chosen
// services → free times of one professional on one day → book.
//
// Times are the shop's local wall time with no zone ("2026-10-20T10:30"),
// prices are centavos. Every error is `{ codigo, mensagem }`; decide on
// `codigo` only. Pure helpers first (unit-tested), then the HTTP client.

export const SCALE_DEFAULT_BASE_URL =
  'https://scale-api-498265201647.southamerica-east1.run.app/parceiros/v1';

export interface ScaleUnit {
  id: string;
  nome: string;
  endereco?: string;
}
export interface ScaleService {
  id: string;
  nome: string;
  duracaoMin: number;
  precoCentavos: number;
  precoAPartirDe: boolean;
}
export interface ScaleProfessional {
  id: string;
  nome: string;
}
export interface ScaleSlot {
  inicio: string;
  fim: string;
}
export interface ScaleBooking {
  id: string;
  codigo: string;
  unidadeId: string;
  barbeiroId: string;
  servicoIds: string[];
  inicio: string;
  fim: string;
  duracaoMin: number;
  status: string;
}

export class ScaleError extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: string,
    message: string,
    public readonly campos?: { campo: string; mensagem: string }[]
  ) {
    super(message);
  }
}

// ---------------- pure helpers ----------------

/** "R$ 50,00" or "a partir de R$ 50,00". */
export function priceText(
  s: Pick<ScaleService, 'precoCentavos' | 'precoAPartirDe'>
): string {
  const brl = (s.precoCentavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
  return s.precoAPartirDe ? `a partir de ${brl}` : brl;
}

/** "2026-10-20T10:30:00" → "2026-10-20T10:30" (what POST /agendamentos takes). */
export function toMinute(inicio: string): string {
  return inicio.slice(0, 16);
}

/**
 * A tappable list row id carries everything book_appointment needs, so the
 * customer's tap is self-contained: `scale|<professional>|<start>|<svc,svc>`.
 * WhatsApp allows 200 chars; three services fit comfortably.
 */
export function scaleSlotId(
  professionalId: string,
  inicio: string,
  serviceIds: string[]
): string {
  return `scale|${professionalId}|${toMinute(inicio)}|${serviceIds.join(',')}`;
}

export function parseScaleSlotId(
  id: string
): { professionalId: string; inicio: string; serviceIds: string[] } | null {
  const m =
    /^scale\|([\w-]+)\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\|([\w,-]+)$/.exec(
      id.trim()
    );
  if (!m) return null;
  return {
    professionalId: m[1],
    inicio: m[2],
    serviceIds: m[3].split(',').filter(Boolean),
  };
}

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** "Sex 16/10 19:30" — fits WhatsApp's 24-char row title. */
export function slotLabel(inicio: string): string {
  const [date, time] = toMinute(inicio).split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${wd} ${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')} ${time}`;
}

/** Local hour of a wall-time string, for the morning/afternoon filter. */
export function slotHour(inicio: string): number {
  return Number(toMinute(inicio).slice(11, 13));
}

/**
 * Merge per-professional slot lists into a few good options: earliest
 * first, and when several professionals share a time, offer it once
 * (the first professional listed) so the list shows different times.
 */
export function pickSlots(
  byProfessional: { professional: ScaleProfessional; slots: ScaleSlot[] }[],
  max: number
): { professional: ScaleProfessional; inicio: string }[] {
  const all = byProfessional.flatMap((p) =>
    p.slots.map((s) => ({
      professional: p.professional,
      inicio: toMinute(s.inicio),
    }))
  );
  all.sort((a, b) => a.inicio.localeCompare(b.inicio));
  const seen = new Set<string>();
  const out: { professional: ScaleProfessional; inicio: string }[] = [];
  for (const s of all) {
    if (seen.has(s.inicio)) continue;
    seen.add(s.inicio);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Stable per (conversation, slot): a retried tool call returns the same booking. */
export function idempotencyKey(conversationId: string, slotId: string): string {
  let h = 5381;
  for (const ch of slotId) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return `nordia-${conversationId.replace(/-/g, '').slice(0, 16)}-${h.toString(36)}`;
}

/** Digits only; what the API reads as the customer's phone. */
export function phoneDigits(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d : null;
}

// ---------------- HTTP client ----------------

const TIMEOUT_MS = 8000;

export interface ScaleClient {
  units(): Promise<ScaleUnit[]>;
  services(unitId: string): Promise<ScaleService[]>;
  professionals(
    unitId: string,
    serviceIds?: string[]
  ): Promise<ScaleProfessional[]>;
  slots(
    professionalId: string,
    date: string,
    serviceIds: string[],
    stepMin?: number
  ): Promise<{ slots: ScaleSlot[]; truncated: boolean }>;
  book(input: {
    professionalId: string;
    serviceIds: string[];
    inicio: string;
    name: string;
    phone: string;
    idempotencyKey: string;
  }): Promise<ScaleBooking>;
}

export function createScaleClient(
  apiKey: string,
  baseUrl: string = SCALE_DEFAULT_BASE_URL,
  fetchImpl: typeof fetch = fetch
): ScaleClient {
  const base = baseUrl.replace(/\/+$/, '');

  async function call<T>(
    path: string,
    init: RequestInit = {},
    retried = false
  ): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (res.status === 429 && !retried) {
      const wait = Math.min(Number(res.headers.get('Retry-After')) || 1, 3);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return call<T>(path, init, true);
    }
    const body = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!res.ok) {
      throw new ScaleError(
        res.status,
        typeof body?.codigo === 'string' ? body.codigo : 'erro_interno',
        typeof body?.mensagem === 'string'
          ? body.mensagem
          : `HTTP ${res.status}`,
        Array.isArray(body?.campos)
          ? (body.campos as { campo: string; mensagem: string }[])
          : undefined
      );
    }
    return body as T;
  }

  const q = (params: Record<string, string | undefined>) =>
    new URLSearchParams(
      Object.entries(params).filter((e): e is [string, string] => !!e[1])
    ).toString();

  return {
    async units() {
      return (
        (await call<{ unidades: ScaleUnit[] }>('/unidades')).unidades ?? []
      );
    },
    async services(unitId) {
      return (
        (
          await call<{ servicos: ScaleService[] }>(
            `/servicos?${q({ unidadeId: unitId })}`
          )
        ).servicos ?? []
      );
    },
    async professionals(unitId, serviceIds) {
      return (
        (
          await call<{ barbeiros: ScaleProfessional[] }>(
            `/barbeiros?${q({ unidadeId: unitId, servicoIds: serviceIds?.join(',') })}`
          )
        ).barbeiros ?? []
      );
    },
    async slots(professionalId, date, serviceIds, stepMin = 30) {
      const r = await call<{ horarios: ScaleSlot[]; truncado: boolean }>(
        `/horarios?${q({
          barbeiroId: professionalId,
          data: date,
          servicoIds: serviceIds.join(','),
          passoMin: String(stepMin),
        })}`
      );
      return { slots: r.horarios ?? [], truncated: !!r.truncado };
    },
    async book(input) {
      return call<ScaleBooking>('/agendamentos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          barbeiroId: input.professionalId,
          servicoIds: input.serviceIds,
          inicio: toMinute(input.inicio),
          cliente: { nome: input.name, telefone: input.phone },
        }),
      });
    },
  };
}
