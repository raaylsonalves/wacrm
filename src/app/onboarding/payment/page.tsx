'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, CreditCard, Loader2, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { CardBrick, type CardSubmit } from '@/components/billing/card-brick';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import {
  PLAN_IDS,
  isBillingCycle,
  isPlanId,
  quoteSubscription,
  type BillingCycle,
  type PaymentMethod,
  type PlanId,
} from '@/lib/billing/plans';
import { sanitizeProfile, suggestPlan } from '@/lib/onboarding/profile';
import { useOnboarding } from '../onboarding-context';

/**
 * Payment gate of the wizard. Nothing here activates the account: the
 * Mercado Pago webhook does, and this page only waits for it by polling
 * /api/billing/status. Prices shown are for display; the server prices
 * the charge itself from the same table (lib/billing/plans).
 */

const SUBS_KEY = process.env.NEXT_PUBLIC_MERCADOPAGO_SUBS_PUBLIC_KEY ?? '';

interface PixData {
  qrCode: string | null;
  qrCodeBase64: string | null;
  ticketUrl: string | null;
  expiresAt: string | null;
}

type Phase = 'choose' | 'confirming' | 'slow';

function Choice({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'rounded-xl border px-3 py-2 text-left text-sm transition-colors',
        selected
          ? 'border-tone-lilac bg-tone-lilac-soft text-tone-lilac-ink font-medium'
          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

export default function OnboardingPaymentPage() {
  const t = useTranslations('Onboarding.payment');
  const tPlan = useTranslations('Onboarding.profile.suggest.plan');
  const router = useRouter();
  const { state, markDone } = useOnboarding();

  const [plan, setPlan] = useState<PlanId>('profissional');
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [method, setMethod] = useState<PaymentMethod>('pix');
  const [phase, setPhase] = useState<Phase>('choose');
  const [pix, setPix] = useState<PixData | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const finished = useRef(false);

  // Preselect from what the visitor chose on the site, else what the
  // company questions suggested.
  useEffect(() => {
    let cancelled = false;
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (cancelled) return;
        const meta = data.user?.user_metadata ?? {};
        const suggested = suggestPlan(sanitizeProfile(state.profile?.profile));
        if (isPlanId(meta.selected_plan)) setPlan(meta.selected_plan);
        else if (suggested && suggested.plan !== 'custom')
          setPlan(suggested.plan);
        if (isBillingCycle(meta.selected_cycle)) setCycle(meta.selected_cycle);
        if (meta.selected_method === 'card' || meta.selected_method === 'pix')
          setMethod(meta.selected_method);
      });
    return () => {
      cancelled = true;
    };
  }, [state.profile?.profile]);

  const complete = useCallback(async () => {
    if (finished.current) return;
    finished.current = true;
    await markDone('payment');
    router.push('/onboarding');
  }, [markDone, router]);

  const readStatus = useCallback(async () => {
    const res = await fetch('/api/billing/status', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { subscriptionStatus?: string };
    return data.subscriptionStatus ?? null;
  }, []);

  // Already paid, or released for a trial: nothing to do on this step.
  useEffect(() => {
    readStatus().then((s) => {
      if (s === 'active' || s === 'exempt') void complete();
    });
  }, [readStatus, complete]);

  // While a Pix is open or a card charge is confirming, wait for the
  // webhook to flip the account.
  const waiting = pix !== null || phase === 'confirming';
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const id = window.setInterval(async () => {
      const s = await readStatus();
      if (s === 'active' || s === 'exempt') {
        window.clearInterval(id);
        void complete();
      } else if (phase === 'confirming' && Date.now() - started > 120_000) {
        window.clearInterval(id);
        setPhase('slow');
      }
    }, 4000);
    return () => window.clearInterval(id);
  }, [waiting, phase, readStatus, complete]);

  const quote = quoteSubscription(plan, cycle);
  const amount = quote.amountCents / 100;
  const money = (n: number) =>
    n.toLocaleString('pt-BR', { minimumFractionDigits: 2 });

  async function generatePix() {
    setBusy(true);
    try {
      const res = await fetch('/api/billing/checkout/pix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, cycle }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        pix?: PixData;
        error?: string;
      };
      if (!res.ok || !data.pix) {
        toast.error(
          t(data.error === 'provider_rejected' ? 'rejected' : 'error')
        );
        return;
      }
      setPix(data.pix);
    } finally {
      setBusy(false);
    }
  }

  async function submitCard(card: CardSubmit) {
    const res = await fetch('/api/billing/checkout/card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan,
        cycle,
        cardToken: card.token,
        payerEmail: card.payerEmail,
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(t(data.error === 'provider_rejected' ? 'rejected' : 'error'));
      throw new Error('checkout failed');
    }
    setPhase('confirming');
  }

  async function copyCode() {
    if (!pix?.qrCode) return;
    try {
      await navigator.clipboard.writeText(pix.qrCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <div>
      <div className="bg-tone-lilac-soft text-tone-lilac-ink flex size-10 items-center justify-center rounded-full">
        <CreditCard className="size-5" />
      </div>
      <h1 className="text-foreground mt-4 text-xl font-semibold">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="mt-6 space-y-5">
        <div className="space-y-2">
          <Label>{t('planLabel')}</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {PLAN_IDS.map((p) => {
              const q = quoteSubscription(p, cycle);
              return (
                <Choice
                  key={p}
                  selected={plan === p}
                  onClick={() => {
                    setPlan(p);
                    setPix(null);
                  }}
                >
                  <span className="block">{tPlan(p)}</span>
                  <span className="text-muted-foreground block text-xs">
                    {t('perMonth', { price: money(q.amountCents / 100) })}
                  </span>
                </Choice>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t('cycleLabel')}</Label>
            <div className="grid grid-cols-2 gap-2">
              <Choice
                selected={cycle === 'monthly'}
                onClick={() => {
                  setCycle('monthly');
                  setPix(null);
                }}
              >
                {t('cycleMonthly')}
              </Choice>
              <Choice
                selected={cycle === 'annual'}
                onClick={() => {
                  setCycle('annual');
                  setPix(null);
                }}
              >
                {t('cycleAnnual')}
              </Choice>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('methodLabel')}</Label>
            <div className="grid grid-cols-2 gap-2">
              <Choice
                selected={method === 'pix'}
                onClick={() => setMethod('pix')}
              >
                {t('methodPix')}
              </Choice>
              <Choice
                selected={method === 'card'}
                onClick={() => setMethod('card')}
              >
                {t('methodCard')}
              </Choice>
            </div>
          </div>
        </div>

        <div className="bg-muted rounded-xl p-4 text-sm">
          <p className="text-foreground text-lg font-semibold">
            {t('perMonth', { price: money(amount) })}
          </p>
          <p className="text-muted-foreground mt-1">
            {cycle === 'annual' ? t('billedAnnual') : t('billedMonthly')}
          </p>
        </div>

        {phase === 'choose' && method === 'pix' && !pix && (
          <Button onClick={generatePix} disabled={busy} className="w-full">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <QrCode className="size-4" />
            )}
            {t('generatePix')}
          </Button>
        )}

        {pix && (
          <div className="border-border space-y-3 rounded-xl border p-4">
            <p className="text-foreground text-sm font-medium">
              {t('pixScan')}
            </p>
            {pix.qrCodeBase64 && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt={t('pixQrAlt')}
                src={`data:image/png;base64,${pix.qrCodeBase64}`}
                className="mx-auto size-48 rounded-lg bg-white p-2"
              />
            )}
            {pix.qrCode && (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs">{t('pixCopy')}</p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={pix.qrCode}
                    className="border-border bg-card min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button variant="outline" onClick={copyCode}>
                    {copied ? <Check className="size-4" /> : t('copy')}
                  </Button>
                </div>
              </div>
            )}
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="size-3 animate-spin" />
              {t('pixWaiting')}
            </p>
          </div>
        )}

        {phase === 'choose' && method === 'card' && (
          <div>
            {SUBS_KEY ? (
              <CardBrick
                key={`${plan}-${cycle}`}
                publicKey={SUBS_KEY}
                amount={amount}
                onSubmit={submitCard}
                onFailed={() => toast.error(t('cardFailed'))}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                {t('notConfigured')}
              </p>
            )}
          </div>
        )}

        {phase === 'confirming' && (
          <p
            className="text-foreground flex items-center gap-2 text-sm"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" />
            {t('confirming')}
          </p>
        )}

        {phase === 'slow' && (
          <div className="space-y-2 text-sm" role="status">
            <p className="text-muted-foreground">{t('stillConfirming')}</p>
            <Button variant="outline" onClick={() => setPhase('confirming')}>
              {t('checkAgain')}
            </Button>
          </div>
        )}

        <p className="text-muted-foreground text-xs">
          {t.rich('terms', {
            terms: (chunks) => (
              <Link href="/termos" target="_blank" className="underline">
                {chunks}
              </Link>
            ),
            privacy: (chunks) => (
              <Link href="/privacidade" target="_blank" className="underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>
    </div>
  );
}
