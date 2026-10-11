'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';

import { useEntitlements } from '@/hooks/use-entitlements';
import type { PlanCount, PlanFeature } from '@/lib/billing/entitlements';
import { cn } from '@/lib/utils';

type Props = { className?: string } & (
  | { feature: PlanFeature; count?: never; used?: never }
  | { count: PlanCount; used: number; feature?: never }
);

/**
 * "Available on the Profissional plan · See plans" — shown next to a
 * create button the account's plan doesn't include (migration 129),
 * instead of letting the click fail. Renders nothing when allowed.
 */
export function PlanNotice(props: Props) {
  const t = useTranslations('PlanGate');
  const { can, roomFor, limit, minPlanFor } = useEntitlements();

  let text: string | null = null;
  if (props.feature) {
    if (!can(props.feature)) {
      text = t('availableOn', { plan: t(`plan.${minPlanFor(props.feature)}`) });
    }
  } else if (props.count && !roomFor(props.count, props.used)) {
    text = t('limitReached', {
      count: limit(props.count) ?? 0,
      what: t(`what.${props.count}`),
    });
  }
  if (!text) return null;

  return (
    <p
      className={cn(
        'text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs',
        props.className
      )}
    >
      <Sparkles className="size-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
      <Link
        href="/settings?tab=billing"
        className="text-primary font-medium hover:underline"
      >
        {t('seePlans')}
      </Link>
    </p>
  );
}

/** Turn a 403 from planGateResponse into a sentence for a toast, or null. */
export function planErrorText(
  t: ReturnType<typeof useTranslations>,
  payload: { code?: string; feature?: string } | null | undefined
): string | null {
  if (payload?.code === 'plan_upgrade_required') return t('upgradeToast');
  if (payload?.code === 'plan_limit_reached') return t('limitToast');
  return null;
}
