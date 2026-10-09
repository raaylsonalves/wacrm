// Billing notices on WhatsApp, sent to the account owner from the
// PLATFORM's own official number with the nordia_* utility templates
// (approved in Meta; they live in the platform account's WABA).
//
// Configured by env: BILLING_WHATSAPP_ACCOUNT_ID = the account that holds
// the templates and the number. Unset (forks, local dev) = no-op. The
// owner's number comes from their sign-up (user metadata
// `whatsapp_phone`, also editable in Settings > Billing); none = skipped.
// Never throws: a notice must not break the billing flow.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { loadNumberForWaba } from '@/lib/whatsapp/official-number';
import { formatDate, type BillingEmail } from '@/lib/email/billing';

const PLAN_LABEL: Record<string, string> = {
  essencial: 'Essencial',
  profissional: 'Profissional',
  escala: 'Escala',
};

/** 39700 -> "397,00" (the templates already print "R$"). */
export function amountText(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * A Brazilian number typed with or without the country code -> digits
 * with 55. Null when it cannot be a phone.
 */
export function normalizeOwnerPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if (d.length >= 12 && d.length <= 15) return d;
  return null;
}

/** Pure: template name + body values for an event; null = no template. */
export function billingTemplateFor(
  e: BillingEmail,
  ctx: { firstName: string; plan: string; accountName: string }
): { name: string; params: string[] } | null {
  switch (e.kind) {
    case 'paid':
      return {
        name: 'nordia_pagamento_confirmado',
        params: [
          ctx.firstName,
          ctx.plan,
          amountText(e.amountCents),
          e.method === 'pix' ? 'Pix' : 'Cartão de crédito',
          e.periodEnd && !e.finished ? formatDate(e.periodEnd) : '—',
        ],
      };
    case 'pix_due':
      return {
        name: 'nordia_lembrete_vencimento',
        params: [
          ctx.firstName,
          ctx.plan,
          formatDate(e.dueAt),
          amountText(e.amountCents),
        ],
      };
    case 'card_declined':
      return {
        name: 'nordia_pagamento_recusado',
        params: [
          ctx.firstName,
          ctx.plan,
          amountText(e.amountCents),
          formatDate(e.graceUntil),
        ],
      };
    case 'ended':
      return {
        name: 'nordia_acesso_encerrado',
        params: [ctx.firstName, ctx.accountName],
      };
    default:
      // past_due (Pix not paid): no approved template yet, e-mail only.
      return null;
  }
}

export async function sendBillingWhatsApp(
  db: SupabaseClient,
  accountId: string,
  event: BillingEmail
): Promise<boolean> {
  const platformAccountId = process.env.BILLING_WHATSAPP_ACCOUNT_ID?.trim();
  if (!platformAccountId) return false;
  try {
    const { data: account } = await db
      .from('accounts')
      .select('name, owner_user_id')
      .eq('id', accountId)
      .maybeSingle();
    const ownerId = account?.owner_user_id as string | undefined;
    if (!ownerId) return false;
    const { data: owner } = await db.auth.admin.getUserById(ownerId);
    const meta = (owner.user?.user_metadata ?? {}) as Record<string, unknown>;
    const to = normalizeOwnerPhone(meta.whatsapp_phone);
    if (!to) return false;

    const { data: sub } = await db
      .from('billing_subscriptions')
      .select('plan')
      .eq('account_id', accountId)
      .maybeSingle();
    const fullName =
      typeof meta.full_name === 'string' ? meta.full_name.trim() : '';
    const tpl = billingTemplateFor(event, {
      firstName: fullName.split(/\s+/)[0] || 'tudo bem',
      plan: PLAN_LABEL[(sub?.plan as string) ?? ''] ?? 'Nordia CRM',
      accountName: (account?.name as string) || 'Nordia CRM',
    });
    if (!tpl) return false;

    const { data: row } = await db
      .from('message_templates')
      .select('name, language, waba_id')
      .eq('account_id', platformAccountId)
      .eq('name', tpl.name)
      .eq('status', 'APPROVED')
      .neq('waba_id', '')
      .limit(1)
      .maybeSingle();
    if (!row) {
      console.warn('[billing/whatsapp] template not approved/synced:', tpl.name);
      return false;
    }
    const number = await loadNumberForWaba(
      db,
      platformAccountId,
      row.waba_id as string
    );
    if (!number) return false;

    await sendTemplateMessage({
      phoneNumberId: number.phone_number_id as string,
      accessToken: decrypt(number.access_token as string),
      to,
      templateName: tpl.name,
      language: (row.language as string) || 'pt_BR',
      params: tpl.params,
    });
    return true;
  } catch (err) {
    console.error('[billing/whatsapp] send failed:', err);
    return false;
  }
}
