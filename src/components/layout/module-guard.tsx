'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useModules } from '@/hooks/use-modules';

/**
 * Sends a client user who typed or bookmarked a page their account didn't
 * buy (migration 091) back to the dashboard. Headless. Waits for the
 * operator lookup so an operator is never bounced by the default "false".
 */
export function ModuleGuard() {
  const pathname = usePathname();
  const router = useRouter();
  const { allowed, ready } = useModules();

  useEffect(() => {
    if (ready && !allowed(pathname)) router.replace('/dashboard');
  }, [ready, allowed, pathname, router]);

  return null;
}
