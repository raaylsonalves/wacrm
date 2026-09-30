'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { useModules } from '@/hooks/use-modules';

/**
 * Wraps the page: a client user on a page their account didn't buy
 * (migration 091) never gets it mounted — no render, no data queries —
 * and is sent to the dashboard. Accounts with every module (modules NULL)
 * render immediately; restricted ones wait for the operator lookup so an
 * operator is never blocked by the default "not an operator".
 */
export function ModuleGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { account } = useAuth();
  const { allowed, ready } = useModules();
  const unrestricted = !!account && account.modules === null;
  const blocked = !unrestricted && (!ready || !allowed(pathname));

  useEffect(() => {
    if (ready && !allowed(pathname)) router.replace('/dashboard');
  }, [ready, allowed, pathname, router]);

  if (blocked) return null;
  return <>{children}</>;
}
