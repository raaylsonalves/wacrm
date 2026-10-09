// Billing e-mails to the account owner: payment confirmed, Pix renewal
// waiting, card declined, payment overdue, subscription ended. Fired from
// lib/billing (webhook + sweep) at the moment each state is entered, so
// each goes out once; Resend's idempotency key covers a retried call.
// Never throws (see send.ts).

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from './send';
import {
  button,
  details,
  escapeHtml,
  layout,
  para,
  siteUrl,
  small,
} from './layout';

export type BillingEmail =
  | {
      kind: 'paid';
      amountCents: number;
      method: 'pix' | 'card';
      /** Next charge / access end; null when unknown. */
      periodEnd: Date | null;
      /** Last installment of a fixed plan: nothing more will be charged. */
      finished: boolean;
    }
  | {
      kind: 'pix_due';
      amountCents: number;
      dueAt: Date;
      ticketUrl: string | null;
    }
  | { kind: 'card_declined'; amountCents: number }
  | { kind: 'past_due'; amountCents: number; graceUntil: Date }
  | { kind: 'ended' };

export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  });
}

/** Pure: subject, HTML and plain text of one billing e-mail. */
export function buildBillingEmail(
  e: BillingEmail,
  accountName: string | null
): { subject: string; html: string; text: string } {
  const billing = `${siteUrl()}/settings?tab=billing`;
  const acc = accountName ? ` da conta <strong>${escapeHtml(accountName)}</strong>` : '';
  const accText = accountName ? ` da conta ${accountName}` : '';
  let subject: string;
  let body: string;
  let text: string;

  switch (e.kind) {
    case 'paid': {
      subject = 'Pagamento confirmado — Nordia CRM';
      const rows: [string, string][] = [
        ['Valor', formatBRL(e.amountCents)],
        ['Forma de pagamento', e.method === 'pix' ? 'Pix' : 'Cartão de crédito'],
      ];
      if (e.periodEnd)
        rows.push([e.finished ? 'Acesso até' : 'Próxima cobrança', formatDate(e.periodEnd)]);
      body =
        para('Olá,') +
        para(`Recebemos o pagamento da assinatura${acc} no <strong>Nordia CRM</strong>. Obrigado!`) +
        details(rows) +
        button('Ver minha assinatura', billing) +
        small('O histórico de pagamentos fica em Configurações → Assinatura.');
      text = `Recebemos o pagamento da assinatura${accText} no Nordia CRM: ${formatBRL(e.amountCents)}.${
        e.periodEnd ? ` ${e.finished ? 'Acesso até' : 'Próxima cobrança'}: ${formatDate(e.periodEnd)}.` : ''
      } Detalhes: ${billing}`;
      break;
    }
    case 'pix_due': {
      subject = 'Seu Pix do Nordia CRM está disponível';
      const pay = e.ticketUrl || billing;
      body =
        para('Olá,') +
        para(`A próxima mensalidade${acc} no <strong>Nordia CRM</strong> já pode ser paga por Pix.`) +
        details([
          ['Valor', formatBRL(e.amountCents)],
          ['Vencimento', formatDate(e.dueAt)],
        ]) +
        button('Pagar com Pix', pay) +
        small('O QR Code e o código copia e cola também ficam em Configurações → Assinatura. Se já pagou, pode ignorar este e-mail.');
      text = `A próxima mensalidade${accText} no Nordia CRM (${formatBRL(e.amountCents)}) vence em ${formatDate(e.dueAt)}. Pague por Pix: ${pay}`;
      break;
    }
    case 'card_declined': {
      subject = 'Não conseguimos cobrar seu cartão — Nordia CRM';
      body =
        para('Olá,') +
        para(`A cobrança de <strong>${formatBRL(e.amountCents)}</strong> da assinatura${acc} no <strong>Nordia CRM</strong> foi recusada pelo cartão.`) +
        para('Vamos tentar novamente nos próximos dias. Para evitar a suspensão do acesso, confira o limite do cartão ou cadastre outro:') +
        button('Atualizar forma de pagamento', billing) +
        small('Seu acesso continua normal durante o período de carência.');
      text = `A cobrança de ${formatBRL(e.amountCents)} da assinatura${accText} no Nordia CRM foi recusada pelo cartão. Atualize a forma de pagamento: ${billing}`;
      break;
    }
    case 'past_due': {
      subject = 'Pagamento em atraso — Nordia CRM';
      body =
        para('Olá,') +
        para(`Ainda não identificamos o pagamento da assinatura${acc} no <strong>Nordia CRM</strong>.`) +
        details([
          ['Valor', formatBRL(e.amountCents)],
          ['Acesso garantido até', formatDate(e.graceUntil)],
        ]) +
        para('Depois dessa data, o acesso ao CRM é suspenso até a regularização.') +
        button('Regularizar pagamento', billing) +
        small('Se você já pagou, pode ignorar este e-mail — a confirmação chega em instantes.');
      text = `Ainda não identificamos o pagamento da assinatura${accText} no Nordia CRM (${formatBRL(e.amountCents)}). Acesso garantido até ${formatDate(e.graceUntil)}. Regularize: ${billing}`;
      break;
    }
    case 'ended': {
      subject = 'Sua assinatura do Nordia CRM foi encerrada';
      body =
        para('Olá,') +
        para(`A assinatura${acc} no <strong>Nordia CRM</strong> foi encerrada e o acesso ao CRM está suspenso.`) +
        para('Seus dados continuam guardados. Para voltar a usar, é só escolher um plano:') +
        button('Reativar assinatura', billing) +
        small('Se acha que isso é um engano, responda a este e-mail ou fale com a gente pelo WhatsApp.');
      text = `A assinatura${accText} no Nordia CRM foi encerrada e o acesso está suspenso. Seus dados continuam guardados. Reative: ${billing}`;
      break;
    }
  }
  return { subject, html: layout(subject, body), text };
}

/**
 * Sends one billing e-mail to the account's owner. `idempotencyKey`
 * should name the event (e.g. `paid:<provider ref>`).
 */
export async function sendBillingEmail(
  db: SupabaseClient,
  accountId: string,
  email: BillingEmail,
  idempotencyKey: string
): Promise<boolean> {
  try {
    const { data: account } = await db
      .from('accounts')
      .select('name, owner_user_id')
      .eq('id', accountId)
      .maybeSingle();
    const ownerId = account?.owner_user_id as string | undefined;
    if (!ownerId) return false;
    const { data: owner } = await db.auth.admin.getUserById(ownerId);
    const to = owner.user?.email;
    if (!to) return false;
    const built = buildBillingEmail(email, (account?.name as string | null) ?? null);
    return await sendEmail({ to, ...built, idempotencyKey: `billing:${accountId}:${idempotencyKey}` });
  } catch (err) {
    console.error('[email/billing] failed:', err);
    return false;
  }
}
