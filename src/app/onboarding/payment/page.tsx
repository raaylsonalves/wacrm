'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CreditCard } from 'lucide-react';
import {
  CheckoutForm,
  readBillingStatus,
} from '@/components/billing/checkout-form';
import { createClient } from '@/lib/supabase/client';
import {
  isBillingCycle,
  isPlanId,
  type BillingCycle,
  type PaymentMethod,
  type PlanId,
} from '@/lib/billing/plans';
import { sanitizeProfile, suggestPlan } from '@/lib/onboarding/profile';
import { useOnboarding } from '../onboarding-context';

/**
 * Payment gate of the wizard. The checkout itself is the shared
 * CheckoutForm (also used by Settings > Billing); this page only picks the
 * starting plan and moves the wizard on once the account is active.
 */
export default function OnboardingPaymentPage() {
  const t = useTranslations('Onboarding.payment');
  const router = useRouter();
  const { state, markDone } = useOnboarding();

  const [plan, setPlan] = useState<PlanId>();
  const [cycle, setCycle] = useState<BillingCycle>();
  const [method, setMethod] = useState<PaymentMethod>();
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

  // Already paid, or released for a trial: nothing to do on this step.
  useEffect(() => {
    readBillingStatus().then((s) => {
      if (s === 'active' || s === 'exempt') void complete();
    });
  }, [complete]);

  return (
    <div>
      <div className="bg-tone-lilac-soft text-tone-lilac-ink flex size-10 items-center justify-center rounded-full">
        <CreditCard className="size-5" />
      </div>
      <h1 className="text-foreground mt-4 text-xl font-semibold">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="mt-6">
        <CheckoutForm
          initialPlan={plan}
          initialCycle={cycle}
          initialMethod={method}
          onActive={() => void complete()}
        />
      </div>
    </div>
  );
}
