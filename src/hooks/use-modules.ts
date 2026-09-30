'use client';

import { useCallback } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useOperator } from '@/hooks/use-operator';
import { isPathAllowed } from '@/lib/account/modules';

/**
 * `allowed(href)` — should this nav entry / page show for the current
 * user? Client users see only the modules their account bought
 * (migration 091); operators running the account see everything.
 */
export function useModules(): {
  allowed: (href: string) => boolean;
  ready: boolean;
} {
  const { account } = useAuth();
  const { isOperator, loaded } = useOperator();
  const modules = account?.modules ?? null;
  const allowed = useCallback(
    (href: string) => isPathAllowed(href, modules, isOperator),
    [modules, isOperator]
  );
  return { allowed, ready: loaded && !!account };
}
