/**
 * Title and body of a notification in the viewer's locale — shared by the
 * notifications page (next-intl's `t`) and the push sender (next-intl's
 * `createTranslator`), so the screen and the phone always say the same.
 *
 * Rows carry raw facts (names, `data`), never a pre-rendered sentence;
 * `title`/`body` columns are only used by case alerts (free text written
 * by the case flow) and rows from before migration 048.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Translate = (key: string, values?: Record<string, any>) => string;

export interface RenderableNotification {
  type: string;
  contact_name?: string | null;
  actor_name?: string | null;
  title?: string | null;
  body?: string | null;
  data?: Record<string, unknown> | null;
  count?: number | null;
}

const HANDOFF_REASONS = new Set([
  'model_requested',
  'reply_cap',
  'provider_failure',
  'empty_reply',
  'rate_limited',
  'system_error',
  'customer_requested_human',
  'audio_unintelligible',
  'case_escalated',
]);

// Migration 027's English sentence, still on rows written before 048.
const LEGACY_ASSIGNED = /^(.+) assigned you a conversation with (.+)$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function formatMoney(value: unknown, currency: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) return '';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: str(currency) || 'BRL',
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return String(n);
  }
}

export function renderNotification(
  n: RenderableNotification,
  t: Translate
): { title: string; body: string | null } {
  const d = n.data ?? {};
  const contact = n.contact_name || t('aContact');
  const actor = n.actor_name || t('someone');
  const count = n.count ?? 1;
  const reason = (r: unknown) =>
    HANDOFF_REASONS.has(str(r)) ? t(`reasons.${str(r)}`) : '';

  switch (n.type) {
    case 'conversation_assigned': {
      const kind = str(d.actor_kind);
      const detail = str(d.summary) || str(d.last_message) || null;
      if (kind === 'human') {
        // The transfer dialog's note says why; better than the last message.
        return {
          title: t('assigned.byPerson', { actor, contact }),
          body: str(d.note) || detail,
        };
      }
      if (kind === 'ai') {
        const why = reason(d.handoff_reason);
        return {
          title: t('assigned.byAi', { contact }),
          body: [why, detail].filter(Boolean).join(' · ') || null,
        };
      }
      if (kind === 'rule') {
        return {
          title: t('assigned.byRule', { contact }),
          body: detail,
        };
      }
      // Rows from before migration 086.
      const legacy = n.body?.match(LEGACY_ASSIGNED);
      if (legacy) {
        const [, a, c] = legacy;
        return {
          title: t('assigned.byPerson', {
            actor: a === 'Someone' ? t('someone') : a,
            contact: c,
          }),
          body: null,
        };
      }
      return n.actor_name
        ? { title: t('assigned.byPerson', { actor, contact }), body: null }
        : { title: t('assigned.byRule', { contact }), body: null };
    }

    case 'customer_replied':
      return {
        title:
          count > 1
            ? t('replied.many', { contact, count })
            : t('replied.one', { contact }),
        body: n.body ?? null,
      };

    case 'handoff_waiting':
      return {
        title: t('handoffWaiting.title', { contact }),
        body: reason(d.handoff_reason) || n.body || null,
      };

    case 'sla_breached':
      return {
        title: t('sla.title', { contact, minutes: Number(d.minutes) || 0 }),
        body: n.body ?? null,
      };

    case 'new_unassigned':
      return {
        title: t('newUnassigned.title', { contact }),
        body: n.body ?? null,
      };

    case 'appointment_reminder':
      return {
        title: t('appointment.title', {
          title: str(d.title),
          time: str(d.time),
        }),
        body: n.contact_name ? t('appointment.with', { contact }) : null,
      };

    case 'deal_won':
    case 'deal_lost': {
      const money = formatMoney(d.value, d.currency);
      return {
        title: t(n.type === 'deal_won' ? 'deal.won' : 'deal.lost', {
          deal: str(d.deal_title),
        }),
        body:
          [
            n.actor_name ? t('deal.by', { actor }) : '',
            money,
            n.contact_name ?? '',
          ]
            .filter(Boolean)
            .join(' · ') || null,
      };
    }

    case 'deal_stage_changed':
      return {
        title: t('deal.moved', { deal: str(d.deal_title) }),
        body:
          [
            `${str(d.from_stage)} → ${str(d.to_stage)}`,
            n.actor_name ? t('deal.by', { actor }) : '',
          ]
            .filter(Boolean)
            .join(' · ') || null,
      };

    case 'channel_disconnected':
      return {
        title: t('channel.title', { channel: str(d.channel) }),
        body: t('channel.body'),
      };

    case 'followup_no_reply':
      return {
        title: t('followupNoReply.title', { contact }),
        body: t('followupNoReply.body', { automation: str(d.automation) }),
      };

    case 'calendar_disconnected':
      return {
        title: t('calendar.title', { email: str(d.email) }),
        body: t('calendar.body'),
      };

    case 'ai_provider_failed':
      return {
        title: t('aiFailed.title'),
        body: t('aiFailed.body', { count }),
      };

    case 'template_status': {
      const status = str(d.status).toLowerCase();
      const known = ['approved', 'rejected', 'paused', 'disabled'].includes(
        status
      );
      return {
        title: t(`template.${known ? status : 'changed'}`, {
          template: str(d.template),
        }),
        body: str(d.reason) || null,
      };
    }

    case 'broadcast_finished':
      return {
        title: t(
          str(d.status) === 'failed' ? 'broadcast.failed' : 'broadcast.done',
          { broadcast: str(d.broadcast) }
        ),
        body: t('broadcast.body', {
          sent: Number(d.sent) || 0,
          total: Number(d.total) || 0,
          failed: Number(d.failed) || 0,
        }),
      };

    default:
      // Case alerts (and anything unknown) carry their own text.
      return { title: n.title || t('fallbackTitle'), body: n.body ?? null };
  }
}
