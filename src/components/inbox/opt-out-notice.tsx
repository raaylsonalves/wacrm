'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { BellOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useCan } from '@/hooks/use-can';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { cn } from '@/lib/utils';

/**
 * "Não recebe mensagens" — the contact wrote STOP (contacts.opted_out_at,
 * set by the webhooks). Broadcasts, automations and follow-ups skip them;
 * replying to a message they send is still fine. Until now nothing showed
 * it anywhere. The panel variant explains it and lets a teammate re-enable
 * sending (only when the customer asked for it); the chip variant is the
 * thread header's reminder.
 */
export function OptOutNotice({
  contactId,
  optedOutAt,
  variant = 'panel',
}: {
  contactId: string;
  optedOutAt: string | null | undefined;
  variant?: 'panel' | 'chip';
}) {
  const t = useTranslations('Inbox.optOut');
  const canEdit = useCan('send-messages');
  const [since, setSince] = useState<string | null>(optedOutAt ?? null);
  const [busy, setBusy] = useState(false);

  // The conversation row can be older than the STOP; read the live value.
  useEffect(() => {
    let alive = true;
    createClient()
      .from('contacts')
      .select('opted_out_at')
      .eq('id', contactId)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setSince((data?.opted_out_at as string | null) ?? null);
      });
    return () => {
      alive = false;
    };
  }, [contactId]);

  if (!since) return null;

  if (variant === 'chip') {
    return (
      <span
        title={t('title')}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] leading-4 font-semibold text-red-700 dark:text-red-300"
      >
        <BellOff className="h-3 w-3" />
        {t('chip')}
      </span>
    );
  }

  async function reactivate() {
    if (!window.confirm(t('confirm'))) return;
    setBusy(true);
    const { error } = await createClient()
      .from('contacts')
      .update({ opted_out_at: null, opt_out_confirmed_at: null })
      .eq('id', contactId);
    setBusy(false);
    if (error) return toast.error(t('failed'));
    setSince(null);
    toast.success(t('reactivated'));
  }

  return (
    <div
      className={cn(
        'mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-left text-xs'
      )}
    >
      <p className="flex items-center gap-1.5 font-semibold text-red-700 dark:text-red-300">
        <BellOff className="h-3.5 w-3.5" />
        {t('title')}
      </p>
      <p className="text-muted-foreground mt-1">
        {t('body', {
          when: formatDistanceToNow(new Date(since), {
            addSuffix: true,
            locale: dateFnsLocale,
          }),
        })}
      </p>
      {canEdit && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void reactivate()}
          className="text-foreground mt-2 inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          {t('reactivate')}
        </button>
      )}
    </div>
  );
}
