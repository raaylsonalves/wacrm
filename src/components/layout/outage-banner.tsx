'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { CloudOff } from 'lucide-react';

import {
  getOutage,
  initialOutage,
  reportStatus,
  subscribeOutage,
} from '@/lib/supabase/outage';

/** How often to probe /api/health while the server is unreachable. */
const PROBE_MS = 15_000;

/**
 * "Server unstable" bar. Without it a Supabase outage looks like an empty
 * account: every page swallows its failed query and renders nothing
 * (2026-10-10). Polls /api/health while down and reloads once it is back,
 * since pages only fetch on mount.
 */
export function OutageBanner() {
  const t = useTranslations('Outage');
  const { down } = useSyncExternalStore(
    subscribeOutage,
    getOutage,
    () => initialOutage
  );

  useEffect(() => {
    if (!down) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          reportStatus(200);
          window.location.reload();
        }
      } catch {
        // still down — keep waiting
      }
    }, PROBE_MS);
    return () => clearInterval(timer);
  }, [down]);

  if (!down) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <CloudOff className="size-4 shrink-0" aria-hidden />
      <span>
        <strong>{t('title')}</strong> {t('body')}
      </span>
    </div>
  );
}
