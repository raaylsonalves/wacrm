'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The platform's view of every paying customer (GET
 * /api/platform/subscribers): plan, method, status, next charge and
 * payments, plus the manual billing actions. Renders nothing for anyone
 * who is not a platform admin (the API answers 403).
 */

interface Subscriber {
  id: string;
  name: string;
  createdAt: string;
  ownerEmail: string | null;
  managed: boolean;
  accountStatus: string;
  subscription: {
    plan: string;
    cycle: string;
    method: string;
    amountCents: number;
    status: string;
    currentPeriodEnd: string | null;
    graceUntil: string | null;
    canceledAt: string | null;
  } | null;
  totalPaidCents: number;
  payments: { method: string; amountCents: number; paidAt: string }[];
}

const FILTERS = [
  'all',
  'active',
  'past_due',
  'pending',
  'canceled',
  'exempt',
] as const;
type Filter = (typeof FILTERS)[number];

const TONE: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  past_due: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  pending: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  canceled: 'bg-muted text-muted-foreground',
  exempt: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
};

export function SubscribersPanel() {
  const t = useTranslations('Operator.subscribers');
  const tStatus = useTranslations('Settings.billing.status');
  const tPlan = useTranslations('Onboarding.profile.suggest.plan');
  const locale = useLocale();
  const [rows, setRows] = useState<Subscriber[] | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/platform/subscribers', { cache: 'no-store' });
    if (res.status === 403) {
      setAllowed(false);
      return;
    }
    if (!res.ok) return;
    const data = (await res.json()) as { subscribers: Subscriber[] };
    setRows(data.subscribers);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows ?? [])
      c[r.accountStatus] = (c[r.accountStatus] ?? 0) + 1;
    return c;
  }, [rows]);
  const mrrCents = useMemo(
    () =>
      (rows ?? [])
        .filter((r) => r.accountStatus === 'active' && r.subscription)
        .reduce((n, r) => n + (r.subscription?.amountCents ?? 0), 0),
    [rows]
  );

  if (!allowed) return null;

  const money = (cents: number) =>
    (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const date = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(locale, {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : '—';

  async function act(id: string, body: Record<string, unknown>) {
    setBusy(id);
    try {
      const res = await fetch(`/api/platform/subscribers/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        toast.error(t('actionFailed'));
        return;
      }
      toast.success(t('actionDone'));
      await load();
    } finally {
      setBusy(null);
    }
  }

  const visible = (rows ?? []).filter(
    (r) => filter === 'all' || r.accountStatus === filter
  );

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-foreground text-lg font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
      </div>

      <TestPix />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('mrr')} value={`R$ ${money(mrrCents)}`} />
        <Stat label={tStatus('active')} value={counts.active ?? 0} />
        <Stat label={tStatus('past_due')} value={counts.past_due ?? 0} />
        <Stat label={tStatus('pending')} value={counts.pending ?? 0} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              filter === f
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:text-foreground'
            )}
          >
            {f === 'all' ? t('filterAll') : tStatus(f)}
            {f !== 'all' && counts[f] ? ` · ${counts[f]}` : ''}
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="flex justify-center py-10">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          {t('empty')}
        </p>
      ) : (
        <ul className="border-border divide-border divide-y rounded-2xl border">
          {visible.map((r) => {
            const sub = r.subscription;
            const expanded = open === r.id;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : r.id)}
                  className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {r.name}
                      {r.managed && (
                        <span className="text-muted-foreground ml-2 text-xs font-normal">
                          {t('managed')}
                        </span>
                      )}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {r.ownerEmail ?? '—'}
                      {sub &&
                        ` · ${tPlan(sub.plan)} · ${sub.method === 'pix' ? 'Pix' : t('card')} · R$ ${money(sub.amountCents)}`}
                    </p>
                  </div>
                  <div className="hidden text-right text-xs sm:block">
                    <p className="text-muted-foreground">{t('nextCharge')}</p>
                    <p className="text-foreground">
                      {date(sub?.currentPeriodEnd ?? null)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
                      TONE[r.accountStatus] ?? TONE.canceled
                    )}
                  >
                    {tStatus(r.accountStatus)}
                  </span>
                  <ChevronDown
                    className={cn(
                      'text-muted-foreground size-4 shrink-0 transition-transform',
                      expanded && 'rotate-180'
                    )}
                  />
                </button>

                {expanded && (
                  <div className="bg-muted/30 space-y-4 px-4 py-4 text-sm">
                    <dl className="grid gap-3 sm:grid-cols-3">
                      <Field label={t('since')} value={date(r.createdAt)} />
                      <Field
                        label={t('nextCharge')}
                        value={date(sub?.currentPeriodEnd ?? null)}
                      />
                      <Field
                        label={t('totalPaid')}
                        value={`R$ ${money(r.totalPaidCents)}`}
                      />
                    </dl>

                    <div>
                      <p className="text-muted-foreground mb-1 text-xs uppercase">
                        {t('payments')}
                      </p>
                      {r.payments.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          {t('noPayments')}
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {r.payments.map((p) => (
                            <li
                              key={`${p.paidAt}-${p.amountCents}`}
                              className="flex justify-between gap-3 text-xs"
                            >
                              <span className="text-muted-foreground">
                                {date(p.paidAt)} ·{' '}
                                {p.method === 'pix' ? 'Pix' : t('card')}
                              </span>
                              <span className="text-foreground">
                                R$ {money(p.amountCents)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {/* A live card subscription is charged by Mercado
                          Pago on its own schedule; extending our date would
                          not move that charge, so it is not offered. */}
                      {sub &&
                        !(
                          sub.method === 'card' &&
                          (sub.status === 'active' || sub.status === 'past_due')
                        ) && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy === r.id}
                              onClick={() =>
                                act(r.id, { action: 'extend', days: 7 })
                              }
                            >
                              {t('extend', { days: 7 })}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy === r.id}
                              onClick={() =>
                                act(r.id, { action: 'extend', days: 30 })
                              }
                            >
                              {t('extend', { days: 30 })}
                            </Button>
                          </>
                        )}
                      {r.accountStatus === 'exempt' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === r.id}
                          onClick={() =>
                            act(r.id, { action: 'require_payment' })
                          }
                        >
                          {t('requirePayment')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === r.id}
                          onClick={() => act(r.id, { action: 'exempt' })}
                        >
                          {t('exempt')}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border-border rounded-2xl border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs uppercase">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

/**
 * A R$ 1,00 Pix to check the live Mercado Pago setup (POST
 * /api/platform/test-pix). It belongs to no subscription: paying it only
 * proves the charge and the webhook work.
 */
function TestPix() {
  const t = useTranslations('Operator.subscribers.testPix');
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<{
    id: string;
    status: string;
    qrCode: string | null;
    qrCodeBase64: string | null;
  } | null>(null);

  // Follow the order until it settles.
  useEffect(() => {
    if (!order || order.status !== 'action_required') return;
    const timer = window.setInterval(async () => {
      const res = await fetch(`/api/platform/test-pix?id=${order.id}`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = (await res.json()) as { status: string };
      setOrder((o) => (o ? { ...o, status: data.status } : o));
    }, 4000);
    return () => window.clearInterval(timer);
  }, [order]);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch('/api/platform/test-pix', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.detail ?? t('failed'));
        return;
      }
      setOrder(data);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-border space-y-3 rounded-2xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-foreground text-sm font-medium">{t('title')}</p>
          <p className="text-muted-foreground text-xs">{t('hint')}</p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={create}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t('create')}
        </Button>
      </div>
      {order && (
        <div className="space-y-2">
          {order.qrCodeBase64 && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={t('qrAlt')}
              src={`data:image/png;base64,${order.qrCodeBase64}`}
              className="size-40 rounded-lg bg-white p-2"
            />
          )}
          {order.qrCode && (
            <input
              readOnly
              value={order.qrCode}
              onFocus={(e) => e.currentTarget.select()}
              className="border-border bg-card w-full rounded-lg border px-3 py-2 font-mono text-xs"
            />
          )}
          <p className="text-muted-foreground text-xs">
            {t('status', { status: order.status })}
          </p>
        </div>
      )}
    </div>
  );
}
