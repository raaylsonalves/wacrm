/**
 * WhatsApp Business app coexistence (specs/whatsapp-coexistence.md).
 *
 * The customer connects through Meta's hosted Embedded Signup link. Meta
 * answers by webhook (account_update PARTNER_ADDED); from there we fetch
 * the customer's business token with our system user token, read the
 * number, and — for a number that stays in the app — ask Meta once for
 * the app's contacts and up to 180 days of history.
 *
 * The parsers below are pure (unit-tested); the Meta calls take named
 * parameters, like lib/whatsapp/meta-api.ts.
 */

import { createHmac } from 'node:crypto';
import { normalizePhone, phonesMatch } from './phone-utils';

const META_API_BASE = 'https://graph.facebook.com/v21.0';

export type SignupMode = 'api' | 'coexistence';

// ---- the hosted link --------------------------------------------------

/**
 * Meta's hosted Embedded Signup page. In coexistence mode the flow offers
 * "connect your existing WhatsApp Business app" (the customer scans a QR
 * in the app); in api mode it onboards a number to the API only.
 */
export function hostedSignupUrl(args: {
  appId: string;
  configId: string;
  mode: SignupMode;
}): string {
  const extras: Record<string, string> = {
    sessionInfoVersion: '3',
    version: 'v4',
  };
  if (args.mode === 'coexistence')
    extras.featureType = 'whatsapp_business_app_onboarding';
  const q = new URLSearchParams({
    app_id: args.appId,
    config_id: args.configId,
    extras: JSON.stringify(extras),
  });
  return `https://business.facebook.com/messaging/whatsapp/onboard/?${q.toString()}`;
}

/** A request this recent may claim a number it did not name. */
export const FRESH_SIGNUP_MS = 60 * 60_000;

/**
 * The waiting request that claims this number (`waiting` newest first).
 * Meta's webhook carries no state of ours: a request that named the number
 * wins; otherwise the newest request opened in the last hour — the
 * customer who just went through Meta's page. Older unnamed requests
 * claim nothing (they could belong to anyone).
 */
export function matchSignup<
  T extends { phone_digits: string | null; created_at: string },
>(waiting: T[], displayPhone: string, now: number = Date.now()): T | null {
  const named = waiting.find(
    (s) => !!s.phone_digits && phonesMatch(s.phone_digits, displayPhone)
  );
  if (named) return named;
  return (
    waiting.find(
      (s) =>
        !s.phone_digits &&
        now - new Date(s.created_at).getTime() < FRESH_SIGNUP_MS
    ) ?? null
  );
}

// ---- webhook payloads -------------------------------------------------

export interface PartnerAdded {
  wabaId: string;
  ownerBusinessId: string;
}

/** account_update with event PARTNER_ADDED → the shared account, else null. */
export function parsePartnerAdded(value: unknown): PartnerAdded | null {
  const v = value as {
    event?: string;
    waba_info?: { waba_id?: string; owner_business_id?: string };
  } | null;
  if (v?.event !== 'PARTNER_ADDED') return null;
  const wabaId = v.waba_info?.waba_id;
  const ownerBusinessId = v.waba_info?.owner_business_id;
  return wabaId && ownerBusinessId
    ? { wabaId: String(wabaId), ownerBusinessId: String(ownerBusinessId) }
    : null;
}

/** Events that mean the number left the API (the owner disconnected it). */
const DISCONNECT_EVENTS = new Set([
  'PARTNER_REMOVED',
  'ACCOUNT_OFFBOARDED',
  'ACCOUNT_DELETED',
  'ACCOUNT_DISABLED',
]);

/** account_update / account_offboarded → a disconnect reason, else null. */
export function parseDisconnect(field: string, value: unknown): string | null {
  if (field === 'account_offboarded') return 'ACCOUNT_OFFBOARDED';
  const ev = (value as { event?: string } | null)?.event;
  return field === 'account_update' && ev && DISCONNECT_EVENTS.has(ev)
    ? ev
    : null;
}

/** A message in an echo or a history thread, in our terms. */
export interface CoexMessage {
  id: string;
  /** The customer's number (digits). */
  customer: string;
  /** Sent by the business (from the app or a companion). */
  fromBusiness: boolean;
  timestamp: number;
  contentType:
    | 'text'
    | 'image'
    | 'document'
    | 'audio'
    | 'video'
    | 'location'
    | 'interactive';
  text: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
}

interface RawMessage {
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string | number;
  type?: string;
  text?: { body?: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string; filename?: string };
  location?: { name?: string; address?: string };
  interactive?: unknown;
  history_context?: { status?: string };
}

const CONTENT_TYPES = new Set([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'location',
  'interactive',
]);

function contentTypeOf(type: string | undefined): CoexMessage['contentType'] {
  if (type && CONTENT_TYPES.has(type))
    return type as CoexMessage['contentType'];
  return type === 'sticker' ? 'image' : 'text';
}

/** Text to store: the body, a caption, or a language-neutral icon (history
 *  media arrives without the file). */
export function messageText(m: RawMessage): string {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? '';
    case 'image':
      return m.image?.caption || '📷';
    case 'video':
      return m.video?.caption || '🎥';
    case 'document':
      return m.document?.caption || m.document?.filename || '📄';
    case 'audio':
      return '🎤';
    case 'sticker':
      return '🖼️';
    case 'location':
      return (
        [m.location?.name, m.location?.address].filter(Boolean).join(' · ') ||
        '📍'
      );
    case 'media_placeholder':
      return '📎';
    default:
      return `[${m.type ?? 'message'}]`;
  }
}

function statusOf(
  s: string | undefined,
  fromBusiness: boolean
): CoexMessage['status'] {
  switch ((s ?? '').toUpperCase()) {
    case 'READ':
    case 'PLAYED':
      return 'read';
    case 'DELIVERED':
      return 'delivered';
    case 'ERROR':
      return 'failed';
    case 'SENT':
    case 'PENDING':
      return 'sent';
    default:
      return fromBusiness ? 'sent' : 'delivered';
  }
}

function toCoex(
  m: RawMessage,
  customer: string,
  fromBusiness: boolean
): CoexMessage | null {
  if (!m.id || !customer) return null;
  const ts = Number(m.timestamp);
  return {
    id: m.id,
    customer: normalizePhone(customer),
    fromBusiness,
    timestamp:
      Number.isFinite(ts) && ts > 0 ? ts : Math.floor(Date.now() / 1000),
    contentType: contentTypeOf(m.type),
    text: messageText(m),
    status: statusOf(m.history_context?.status, fromBusiness),
  };
}

/** smb_message_echoes → what the owner sent from the phone. */
export function parseEchoes(value: unknown): CoexMessage[] {
  const echoes =
    (value as { message_echoes?: RawMessage[] } | null)?.message_echoes ?? [];
  return echoes
    .map((m) => toCoex(m, m.to ?? '', true))
    .filter((m): m is CoexMessage => m !== null);
}

export interface HistoryChunk {
  phase: number;
  progress: number;
  /** Meta's 2593109: the owner declined to share history. */
  declined: boolean;
  messages: CoexMessage[];
}

/** history → one chunk per item, business messages told apart by `to`. */
export function parseHistory(
  value: unknown,
  businessPhone: string
): HistoryChunk[] {
  type Item = {
    metadata?: { phase?: number; progress?: number };
    errors?: { code?: number }[];
    threads?: { id?: string; messages?: RawMessage[] }[];
  };
  const items = (value as { history?: Item[] } | null)?.history ?? [];
  const business = normalizePhone(businessPhone);
  return items.map((it) => ({
    phase: Number(it.metadata?.phase ?? 0),
    progress: Number(it.metadata?.progress ?? 0),
    declined: (it.errors ?? []).some((e) => e.code === 2593109),
    messages: (it.threads ?? []).flatMap((th) =>
      (th.messages ?? [])
        .map((m) => {
          const fromBusiness =
            !!m.to || (!!business && normalizePhone(m.from ?? '') === business);
          return toCoex(
            m,
            th.id ?? (fromBusiness ? m.to : m.from) ?? '',
            fromBusiness
          );
        })
        .filter((m): m is CoexMessage => m !== null)
    ),
  }));
}

export interface AppContact {
  action: 'add' | 'remove';
  phone: string;
  name: string;
}

/** smb_app_state_sync → contacts added, edited or removed in the app. */
export function parseStateSync(value: unknown): AppContact[] {
  type Entry = {
    type?: string;
    action?: string;
    contact?: {
      full_name?: string;
      first_name?: string;
      phone_number?: string;
    };
  };
  const entries = (value as { state_sync?: Entry[] } | null)?.state_sync ?? [];
  return entries
    .filter((e) => e.type === 'contact' && e.contact?.phone_number)
    .map((e) => ({
      action: e.action === 'remove' ? 'remove' : 'add',
      phone: normalizePhone(e.contact!.phone_number!),
      name: (e.contact!.full_name || e.contact!.first_name || '').trim(),
    }));
}

// ---- Meta calls -------------------------------------------------------

async function metaJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  if (!res.ok)
    throw new Error(body.error?.message || `Meta API error: ${res.status}`);
  return body;
}

/** HMAC-SHA256 of the token keyed with the app secret (appsecret_proof). */
export function appSecretProof(token: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(token).digest('hex');
}

/**
 * The customer's business token, fetched with OUR system user token on
 * the customer's business portfolio (hosted Embedded Signup).
 */
export async function fetchBusinessToken(args: {
  ownerBusinessId: string;
  systemToken: string;
  appSecret: string;
}): Promise<string> {
  const res = await fetch(
    `${META_API_BASE}/${args.ownerBusinessId}/system_user_access_tokens`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${args.systemToken}`,
      },
      body: new URLSearchParams({
        appsecret_proof: appSecretProof(args.systemToken, args.appSecret),
        fetch_only: 'true',
      }).toString(),
    }
  );
  const data = await metaJson<{ access_token?: string }>(res);
  if (!data.access_token) throw new Error('Meta returned no business token');
  return data.access_token;
}

export interface CoexPhone {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  is_on_biz_app?: boolean;
  platform_type?: string;
}

/** The numbers on the customer's WhatsApp account, with app status. */
export async function listCoexPhones(args: {
  wabaId: string;
  accessToken: string;
}): Promise<CoexPhone[]> {
  const res = await fetch(
    `${META_API_BASE}/${args.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,is_on_biz_app,platform_type`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } }
  );
  return (await metaJson<{ data?: CoexPhone[] }>(res)).data ?? [];
}

/**
 * Ask Meta once for the app's contacts or history. Only allowed within
 * 24 h of onboarding, once per type; the results arrive by webhook.
 */
export async function requestSmbSync(args: {
  phoneNumberId: string;
  accessToken: string;
  syncType: 'smb_app_state_sync' | 'history';
}): Promise<string> {
  const res = await fetch(
    `${META_API_BASE}/${args.phoneNumberId}/smb_app_data`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        sync_type: args.syncType,
      }),
    }
  );
  const data = await metaJson<{ request_id?: string }>(res);
  return data.request_id ?? '';
}
