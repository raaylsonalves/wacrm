'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BillingPhone } from '@/components/billing/billing-phone';
import { CardBrick } from '@/components/billing/card-brick';
import { CheckoutForm } from '@/components/billing/checkout-form';
import { confirmDialog } from '@/components/confirm-dialog';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { useAuth } from '@/hooks/use-auth';
import { canManageBilling } from '@/lib/auth/roles';
import { isBillingCycle, isPlanId } from '@/lib/billing/plans';

const SUBS_KEY = process.env.NEXT_PUBLIC_MERCADOPAGO_SUBS_PUBLIC_KEY ?? '';

interface BillingStatus {
  subscriptionStatus: string | null;
  subscription: {
    plan: string;
    cycle: string;
    method: string;
    amount_cents: number;
    status: string;
    current_period_end: string | null;
    canceled_at: string | null;
  } | null;
  openPixOrder: {
    qr_code: string | null;
    qr_code_base64: string | null;
    ticket_url: string | null;
    expires_at: string | null;
  } | null;
  payments?: { method: string; amount_cents: number; paid_at: string }[];
}

export function BillingPanel() {
  const t = useTranslations('Settings.billing');
  const tPlan = useTranslations('Onboarding.profile.suggest.plan');
  const locale = useLocale();
  const { accountRole } = useAuth();
  const isOwner = accountRole ? canManageBilling(accountRole) : false;

  const [data, setData] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const [reload, setReload] = useState(0);
  // Inline panels: subscribing (again) and swapping the card.
  const [checkout, setCheckout] = useState(false);
  const [changingCard, setChangingCard] = useState(false);
  const [reactivatingCard, setReactivatingCard] = useState(false);
  const [reactivating, setReactivating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/billing/status', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<BillingStatus>) : null))
      .then((d) => {
        if (cancelled) return;
        if (d) setData(d);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // A first (or renewed) Pix is waiting: watch for the payment and reload
  // the whole app once the account is active, which lifts the billing lock.
  const waitingPix =
    !!data?.openPixOrder && data.subscriptionStatus !== 'active';
  useEffect(() => {
    if (!waitingPix) return;
    const id = window.setInterval(async () => {
      const res = await fetch('/api/billing/status', { cache: 'no-store' });
      if (!res.ok) return;
      const d = (await res.json()) as { subscriptionStatus?: string };
      if (d.subscriptionStatus === 'active') window.location.reload();
    }, 5000);
    return () => window.clearInterval(id);
  }, [waitingPix]);

  const money = (cents: number) =>
    (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const date = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(locale, {
          day: '2-digit',
          month: 'long',
          year: 'numeric',
        })
      : '—';

  async function cancel() {
    const ok = await confirmDialog(t('cancelConfirm'), {
      confirmLabel: t('cancelAction'),
      destructive: true,
      action: async () => {
        const res = await fetch('/api/billing/cancel', { method: 'POST' });
        if (!res.ok) {
          toast.error(t('cancelFailed'));
          throw new Error('cancel failed');
        }
      },
    });
    if (ok) {
      toast.success(t('cancelled'));
      setReload((n) => n + 1);
    }
  }

  async function submitNewCard(card: { token: string }) {
    const res = await fetch('/api/billing/card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardToken: card.token }),
    });
    if (!res.ok) {
      toast.error(t('cardUpdateFailed'));
      throw new Error('card update failed');
    }
    toast.success(t('cardUpdated'));
    setChangingCard(false);
    setReload((n) => n + 1);
  }

  // Paid: reload the whole app so the dashboard's billing lock lifts.
  const onActive = () => window.location.reload();

  // Cancelled, still inside the paid period: resume without charging.
  async function reactivatePix() {
    setReactivating(true);
    try {
      const res = await fetch('/api/billing/reactivate', { method: 'POST' });
      if (!res.ok) {
        toast.error(t('reactivateFailed'));
        return;
      }
      toast.success(t('reactivated'));
      window.location.reload();
    } finally {
      setReactivating(false);
    }
  }

  // Card: a new subscription whose first charge waits for the period end.
  async function reactivateWithCard(card: {
    token: string;
    payerEmail: string | null;
  }) {
    const res = await fetch('/api/billing/checkout/card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: data?.subscription?.plan,
        cycle: data?.subscription?.cycle,
        cardToken: card.token,
        payerEmail: card.payerEmail,
      }),
    });
    if (!res.ok) {
      toast.error(t('reactivateFailed'));
      throw new Error('reactivate failed');
    }
    toast.success(t('reactivatedCard'));
    window.location.reload();
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  const accountStatus = data?.subscriptionStatus ?? null;
  // A cancelled account paying again has a pending charge while the account
  // itself still reads `canceled`: show what is happening now.
  const status =
    data?.subscription?.status === 'pending' && accountStatus !== 'exempt'
      ? 'pending'
      : accountStatus;
  const sub = data?.subscription ?? null;
  const pix = data?.openPixOrder ?? null;

  if (status === 'exempt') {
    return (
      <section className="space-y-6">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <p className="text-muted-foreground text-sm">{t('exempt')}</p>
      </section>
    );
  }

  const canceled = sub?.status === 'canceled';
  // Subscribing again (or paying a first charge) happens right here; a
  // Pix already waiting is shown above instead.
  // Cancelled but the paid period is still running: resume, don't re-buy.
  const stillPaid =
    canceled &&
    !!sub?.current_period_end &&
    new Date(sub.current_period_end).getTime() > Date.now();
  const canSubscribe =
    (!sub ||
      canceled ||
      status === 'pending' ||
      status === 'canceled' ||
      // An overdue Pix month whose charge expired or was never created.
      (status === 'past_due' && sub.method === 'pix')) &&
    !pix &&
    !stillPaid;
  // The card of a live subscription is swapped in place at Mercado Pago.
  const canChangeCard =
    sub?.method === 'card' &&
    !canceled &&
    (status === 'active' || status === 'past_due');
  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="border-border space-y-3 rounded-2xl border p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground text-lg font-semibold">
            {sub && isPlanId(sub.plan) ? tPlan(sub.plan) : t('noPlan')}
          </span>
          {status && (
            <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-xs font-medium">
              {/* Cancelled but still paid: the account is active, the
                  subscription is not — say the latter. */}
              {t(`status.${canceled ? 'canceled' : status}`)}
            </span>
          )}
        </div>

        {sub && (
          <dl className="text-muted-foreground grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase">{t('price')}</dt>
              <dd className="text-foreground">
                {t('perMonth', { price: money(sub.amount_cents) })}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase">{t('method')}</dt>
              <dd className="text-foreground">
                {sub.method === 'pix' ? t('methodPix') : t('methodCard')} ·{' '}
                {sub.cycle === 'annual' ? t('cycleAnnual') : t('cycleMonthly')}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase">
                {canceled ? t('accessUntil') : t('nextCharge')}
              </dt>
              <dd className="text-foreground">
                {sub.status === 'pending' && !sub.current_period_end
                  ? t('afterPayment')
                  : date(sub.current_period_end)}
              </dd>
            </div>
          </dl>
        )}

        {status === 'past_due' && (
          <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            {sub?.method === 'card' ? t('pastDueCard') : t('pastDue')}
          </p>
        )}
        {canceled && (
          <p className="text-muted-foreground text-sm">
            {stillPaid ? t('canceledNote') : t('canceledEndedNote')}
          </p>
        )}
      </div>

      {pix && isOwner && (
        <div className="border-border space-y-3 rounded-2xl border p-5">
          <p className="text-foreground text-sm font-medium">
            {t('pixOpenTitle')}
          </p>
          {pix.qr_code_base64 && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={t('pixQrAlt')}
              src={`data:image/png;base64,${pix.qr_code_base64}`}
              className="size-44 rounded-lg bg-white p-2"
            />
          )}
          {pix.qr_code && (
            <div className="flex gap-2">
              <input
                readOnly
                value={pix.qr_code}
                onFocus={(e) => e.currentTarget.select()}
                className="border-border bg-card min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-xs"
              />
              <Button variant="outline" onClick={() => copy(pix.qr_code!)}>
                {copied ? <Check className="size-4" /> : t('copy')}
              </Button>
            </div>
          )}
          {pix.expires_at && (
            <p className="text-muted-foreground text-xs">
              {t('pixExpires', { date: date(pix.expires_at) })}
            </p>
          )}
        </div>
      )}

      {data?.payments && data.payments.length > 0 && (
        <div className="border-border space-y-3 rounded-2xl border p-5">
          <p className="text-foreground text-sm font-medium">
            {t('historyTitle')}
          </p>
          <ul className="divide-border divide-y text-sm">
            {data.payments.map((p) => (
              <li
                key={`${p.paid_at}-${p.amount_cents}`}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="text-muted-foreground">
                  {date(p.paid_at)} ·{' '}
                  {p.method === 'pix' ? t('methodPix') : t('methodCard')}
                </span>
                <span className="text-foreground font-medium">
                  R$ {money(p.amount_cents)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isOwner ? (
        <>
          <div className="flex flex-wrap gap-2">
            {stillPaid && !reactivatingCard && (
              <Button
                disabled={reactivating}
                onClick={() =>
                  sub?.method === 'pix'
                    ? void reactivatePix()
                    : setReactivatingCard(true)
                }
              >
                {reactivating && <Loader2 className="size-4 animate-spin" />}
                {t('reactivate')}
              </Button>
            )}
            {canSubscribe && !checkout && (
              <Button onClick={() => setCheckout(true)}>
                {canceled || !sub ? t('subscribe') : t('payNow')}
              </Button>
            )}
            {canChangeCard && !changingCard && (
              <Button
                variant={status === 'past_due' ? 'default' : 'outline'}
                onClick={() => setChangingCard(true)}
              >
                {t('changeCard')}
              </Button>
            )}
            {sub &&
              !canceled &&
              status !== 'pending' &&
              sub.status !== 'pending' && (
                <Button variant="outline" onClick={cancel}>
                  {t('cancelAction')}
                </Button>
              )}
          </div>

          {checkout && (
            <div className="border-border space-y-4 rounded-2xl border p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-foreground text-sm font-medium">
                  {t('checkoutTitle')}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCheckout(false)}
                >
                  {t('close')}
                </Button>
              </div>
              <CheckoutForm
                initialPlan={sub && isPlanId(sub.plan) ? sub.plan : undefined}
                initialCycle={
                  sub && isBillingCycle(sub.cycle) ? sub.cycle : undefined
                }
                initialMethod={sub?.method === 'pix' ? 'pix' : undefined}
                onActive={onActive}
              />
            </div>
          )}

          {reactivatingCard && sub && (
            <div className="border-border space-y-4 rounded-2xl border p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-foreground text-sm font-medium">
                  {t('reactivate')}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setReactivatingCard(false)}
                >
                  {t('close')}
                </Button>
              </div>
              <p className="text-muted-foreground text-sm">
                {t('reactivateCardHint', {
                  date: date(sub.current_period_end),
                })}
              </p>
              {SUBS_KEY ? (
                <CardBrick
                  publicKey={SUBS_KEY}
                  amount={sub.amount_cents / 100}
                  onSubmit={reactivateWithCard}
                  onFailed={() => toast.error(t('reactivateFailed'))}
                />
              ) : null}
            </div>
          )}

          {changingCard && sub && (
            <div className="border-border space-y-4 rounded-2xl border p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-foreground text-sm font-medium">
                  {t('changeCardTitle')}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setChangingCard(false)}
                >
                  {t('close')}
                </Button>
              </div>
              <p className="text-muted-foreground text-sm">
                {t('changeCardHint')}
              </p>
              {SUBS_KEY ? (
                <CardBrick
                  publicKey={SUBS_KEY}
                  amount={sub.amount_cents / 100}
                  onSubmit={submitNewCard}
                  onFailed={() => toast.error(t('cardUpdateFailed'))}
                />
              ) : null}
            </div>
          )}

          <BillingPhone />
        </>
      ) : (
        <p className="text-muted-foreground text-sm">{t('ownerOnly')}</p>
      )}
    </section>
  );
}
