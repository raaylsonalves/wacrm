// ============================================================
// Pure helpers for the landing page's contact form
// (POST /api/landing/lead). Kept apart from the route so they are
// unit-tested without Supabase.
// ============================================================

export const LEAD_INTERESTS = [
  'Landing page',
  'Agendamento',
  'Integração',
  'Implantação do CRM',
] as const;
export type LeadInterest = (typeof LEAD_INTERESTS)[number];

/** Tag every landing lead carries, so the team can filter them. */
export const LEAD_TAG = 'lead-site';

export interface LeadInput {
  name: string;
  phone: string;
  interest: LeadInterest;
}

/**
 * A Brazilian number typed the local way — "(85) 99999-0000", with or
 * without the 55 — as E.164. Anything that is not 10–13 digits after
 * stripping is rejected rather than guessed.
 */
export function toE164BR(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  // An explicit "+" with another country code is not a Brazilian number.
  if (raw.trim().startsWith('+') && !digits.startsWith('55')) return null;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55'))
    return `+${digits}`;
  return null;
}

export type LeadParse =
  | { ok: true; lead: LeadInput }
  | { ok: false; error: 'invalid_phone' | 'invalid_body' };

export function parseLead(body: unknown): LeadParse {
  if (!body || typeof body !== 'object')
    return { ok: false, error: 'invalid_body' };
  const b = body as Record<string, unknown>;
  const phone = typeof b.phone === 'string' ? toE164BR(b.phone) : null;
  if (!phone) return { ok: false, error: 'invalid_phone' };
  const name =
    typeof b.name === 'string'
      ? b.name.replace(/\s+/g, ' ').trim().slice(0, 80)
      : '';
  const interest =
    LEAD_INTERESTS.find((i) => i === b.interest) ?? LEAD_INTERESTS[0];
  return { ok: true, lead: { name, phone, interest } };
}

/** Tag naming the service asked for, e.g. "interesse:agendamento". */
export function interestTag(interest: LeadInterest): string {
  return `interesse:${interest
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
}
