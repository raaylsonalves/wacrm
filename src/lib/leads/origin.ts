/**
 * Lead origin and loss reasons (migration 134, specs/painel-gestor.md).
 *
 * Origin is the first touch: a Meta click-to-WhatsApp ad sends a
 * `referral` on the customer's first message; a tracking link pre-fills
 * the message with "#code". Anything else that arrives over WhatsApp is
 * organic.
 */

/** The `referral` object Meta attaches to a message sent from an ad. */
export interface MetaReferral {
  source_url?: string;
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
}

export interface TrackingLink {
  code: string;
  label: string;
}

export type LeadSource = 'ad' | 'link' | 'organic' | 'manual' | 'import' | 'api';

export interface LeadOrigin {
  source: LeadSource;
  detail: Record<string, string> | null;
}

const CODE_RE = /#([a-z0-9_-]{2,30})\b/gi;

/** Every "#code" in a text, lowercased, in order. */
export function codesIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(CODE_RE)].map((m) => m[1].toLowerCase());
}

export function detectOrigin(
  referral: MetaReferral | null | undefined,
  text: string | null | undefined,
  links: TrackingLink[]
): LeadOrigin {
  if (referral && (referral.source_id || referral.source_url || referral.ctwa_clid || referral.body)) {
    const detail: Record<string, string> = {};
    for (const k of ['source_id', 'source_type', 'source_url', 'headline', 'body', 'ctwa_clid'] as const) {
      const v = referral[k];
      if (typeof v === 'string' && v) detail[k] = v.slice(0, k === 'body' ? 1000 : 300);
    }
    return { source: 'ad', detail };
  }
  for (const code of codesIn(text)) {
    const link = links.find((l) => l.code === code);
    if (link) return { source: 'link', detail: { code: link.code, label: link.label } };
  }
  return { source: 'organic', detail: null };
}

/**
 * The ad a WhatsApp Web session (WAHA) saw the customer come from: the
 * click-to-WhatsApp preview sits in the raw message's
 * `contextInfo.externalAdReply` (NOWEB `_data.message.<type>`).
 */
export function adReferralFromRaw(raw: unknown): MetaReferral | null {
  const message = (raw as { message?: Record<string, unknown> } | null)?.message;
  if (!message || typeof message !== 'object') return null;
  for (const part of Object.values(message)) {
    const ad = (part as { contextInfo?: { externalAdReply?: Record<string, unknown> } } | null)
      ?.contextInfo?.externalAdReply;
    if (!ad || typeof ad !== 'object') continue;
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const referral: MetaReferral = {
      source_url: s(ad.sourceUrl),
      source_id: s(ad.sourceId),
      source_type: s(ad.sourceType),
      headline: s(ad.title),
      body: s(ad.body),
      ctwa_clid: s(ad.ctwaClid),
    };
    if (referral.source_url || referral.source_id || referral.ctwa_clid || referral.body) {
      return referral;
    }
  }
  return null;
}

/** For the AI: the ad a recent lead clicked, so "isso" has a referent. */
export function adPromptLine(detail: Record<string, string> | null | undefined): string | null {
  const text = [detail?.headline, detail?.body].filter(Boolean).join(' — ');
  if (!text) return null;
  return `The customer started this chat from an ad. When they say "isso" / "esse" / ask for more information, they mean what the ad offers. Ad text: "${text}"${detail?.source_url ? ` (${detail.source_url})` : ''}`;
}

/** A tracking code: 2–30 of a-z, 0-9, _ and -, from whatever was typed. */
export function slugCode(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

/** wa.me link that opens the chat with the message and its #code typed in. */
export function trackingUrl(phone: string, message: string, code: string): string {
  const digits = phone.replace(/\D/g, '');
  const text = `${message.trim()} #${code}`.trim();
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export const LOSS_REASONS = ['price', 'timing', 'competitor', 'no_response', 'not_fit', 'other'] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

/** The reason key a model answered with, or null. */
export function parseLossReason(text: string): LossReason | null {
  const t = text.toLowerCase();
  return LOSS_REASONS.find((r) => new RegExp(`\\b${r}\\b`).test(t)) ?? null;
}
