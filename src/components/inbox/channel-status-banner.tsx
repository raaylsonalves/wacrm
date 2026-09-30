'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { WifiOff } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';

interface WahaChannel {
  id: string;
  label: string;
  status: string;
}

/**
 * Tells the inbox when a number stops receiving: each WAHA channel that
 * is disconnected, the official number when it's configured but not
 * connected, or no number at all. A WAHA session dropping flips its row
 * (webhook session.status); the banner re-checks every minute and on
 * tab focus.
 *
 * Replaces the old check that only looked at the official number, which
 * warned "not connected" forever on accounts that only use WAHA.
 */
export function ChannelStatusBanner() {
  const t = useTranslations('Inbox.channelBanner');
  const { accountId } = useAuth();
  const [meta, setMeta] = useState<'none' | 'connected' | 'down' | null>(null);
  const [waha, setWaha] = useState<WahaChannel[]>([]);

  const load = useCallback(async () => {
    if (!accountId) return;
    const db = createClient();
    const [{ data: cfg }, { data: channels }] = await Promise.all([
      db
        .from('whatsapp_config')
        .select('status')
        .eq('account_id', accountId)
        .maybeSingle(),
      db
        .from('whatsapp_waha_channels')
        .select('id, label, status')
        .eq('account_id', accountId),
    ]);
    setMeta(!cfg ? 'none' : cfg.status === 'connected' ? 'connected' : 'down');
    setWaha((channels ?? []) as WahaChannel[]);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Polled, not Realtime: whatsapp_waha_channels isn't in the realtime
  // publication, and adding it would ship each row (with its WAHA key)
  // to every member's browser. A minute is soon enough for "a number
  // dropped", and a tab coming back to focus re-checks at once.
  useEffect(() => {
    const id = setInterval(() => void load(), 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  if (meta === null) return null;

  const downWaha = waha.filter((c) => c.status !== 'connected');
  const messages: string[] = [
    ...downWaha.map((c) => t('wahaDown', { channel: c.label })),
    ...(meta === 'down' ? [t('metaDown')] : []),
    ...(meta === 'none' && waha.length === 0 ? [t('none')] : []),
  ];
  if (messages.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
      <WifiOff className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1 text-xs text-amber-700 dark:text-amber-400">
        {messages.map((m) => (
          <p key={m}>{m}</p>
        ))}
      </div>
      <Link
        href="/settings?tab=whatsapp"
        className="shrink-0 rounded-md border border-amber-500/40 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
      >
        {t('reconnect')}
      </Link>
    </div>
  );
}
