'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canManageBilling } from '@/lib/auth/roles';

/**
 * Heads-up for the account owner when money needs attention: a payment is
 * late (past_due) or a renewal Pix is waiting. It only reads
 * /api/billing/status, so it never decides anything; the server gates.
 */
export function BillingBanner() {
  const t = useTranslations('Settings.billing.banner');
  const { accountRole } = useAuth();
  const [state, setState] = useState<'late' | 'renewal' | null>(null);

  useEffect(() => {
    if (!accountRole || !canManageBilling(accountRole)) return;
    let cancelled = false;
    fetch('/api/billing/status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          d: {
            subscriptionStatus?: string;
            openPixOrder?: unknown;
          } | null
        ) => {
          if (cancelled || !d) return;
          if (d.subscriptionStatus === 'past_due') setState('late');
          else if (d.openPixOrder && d.subscriptionStatus === 'active')
            setState('renewal');
        }
      );
    return () => {
      cancelled = true;
    };
  }, [accountRole]);

  if (!state) return null;
  return (
    <div
      role="status"
      className="mx-3 mt-3 flex items-start gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-700 lg:mx-0 dark:text-amber-300"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <p className="flex-1">
        {state === 'late' ? t('late') : t('renewal')}{' '}
        <Link
          href="/settings?tab=billing"
          className="font-semibold underline underline-offset-2"
        >
          {t('action')}
        </Link>
      </p>
    </div>
  );
}
