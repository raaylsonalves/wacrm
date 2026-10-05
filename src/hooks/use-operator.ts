'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';

/**
 * Is the signed-in user a platform operator (migration 090), and which is
 * their home account? RLS lets a user read only their own row, so for
 * everyone else this is simply "not an operator".
 */
export function useOperator(): {
  isOperator: boolean;
  homeAccountId: string | null;
  /** False until the lookup finished — gates must not act on the default. */
  loaded: boolean;
} {
  const { user } = useAuth();
  const [state, setState] = useState<{
    isOperator: boolean;
    homeAccountId: string | null;
    loaded: boolean;
  }>({
    isOperator: false,
    homeAccountId: null,
    loaded: false,
  });

  useEffect(() => {
    if (!user) return;
    let alive = true;
    createClient()
      .from('platform_operators')
      .select('home_account_id')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) {
          setState({
            isOperator: !!data,
            homeAccountId:
              (data?.home_account_id as string | undefined) ?? null,
            loaded: true,
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [user]);

  return state;
}

/**
 * Switch the active account and hard-reload into it. A full navigation on
 * purpose: every Realtime subscription and cache is keyed to the previous
 * account, and hot-swapping them in place is how wrong-account writes
 * happen.
 */
export async function switchAccount(accountId: string): Promise<string | null> {
  const { error } = await createClient().rpc('switch_account', {
    p_account: accountId,
  });
  if (error) return error.message;
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload on purpose: switching accounts must drop every cached query
  window.location.assign('/dashboard');
  return null;
}
