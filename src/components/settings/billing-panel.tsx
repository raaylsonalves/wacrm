'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/confirm-dialog';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { useAuth } from '@/hooks/use-auth';
import { canManageBilling } from '@/lib/auth/roles';
import { isPlanId } from '@/lib/billing/plans';

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

  const status = data?.subscriptionStatus ?? null;
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
              {t(`status.${status}`)}
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
                {date(sub.current_period_end)}
              </dd>
            </div>
          </dl>
        )}

        {status === 'past_due' && (
          <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            {t('pastDue')}
          </p>
        )}
        {canceled && (
          <p className="text-muted-foreground text-sm">{t('canceledNote')}</p>
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

      {isOwner ? (
        <div className="flex flex-wrap gap-2">
          {(!sub ||
            canceled ||
            status === 'past_due' ||
            status === 'pending') && (
            <Link href="/onboarding/payment">
              <Button>{canceled || !sub ? t('subscribe') : t('payNow')}</Button>
            </Link>
          )}
          {sub && !canceled && status !== 'pending' && (
            <Button variant="outline" onClick={cancel}>
              {t('cancelAction')}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t('ownerOnly')}</p>
      )}
    </section>
  );
}
