'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  isSubscriptionStatus,
  type SubscriptionStatus,
} from '@/lib/billing/status';

/** The account's subscription status; null while loading or unknown. */
export function useSubscriptionStatus(
  accountId: string | null
): SubscriptionStatus | null {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from('accounts')
      .select('subscription_status')
      .eq('id', accountId)
      .maybeSingle()
      .then(({ data }) => {
        const v = data?.subscription_status;
        if (!cancelled && isSubscriptionStatus(v)) setStatus(v);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  return status;
}
