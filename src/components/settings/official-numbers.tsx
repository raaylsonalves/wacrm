'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { WhatsAppConfig } from './whatsapp-config';

/**
 * Settings → WhatsApp with several official numbers
 * (specs/multi-official-numbers.md). The list picks which number the form
 * below edits, adds one, or makes one the primary. With a single number
 * the page looks as before, plus the "add number" button.
 */

interface OfficialNumber {
  id: string;
  label: string | null;
  phone_number_id: string;
  display_phone_number: string | null;
  is_primary: boolean;
  status: string;
  registered_at: string | null;
  /** Meta refused it on the last health check (migration 120). */
  health_error: string | null;
}

export function OfficialNumbers() {
  const t = useTranslations('Settings.whatsapp.numbers');
  const { canEditSettings } = useAuth();
  const [numbers, setNumbers] = useState<OfficialNumber[] | null>(null);
  // Which number the form edits; 'new' = the add form.
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (select?: string | null) => {
    const res = await fetch('/api/whatsapp/numbers', { cache: 'no-store' });
    if (!res.ok) {
      setNumbers([]);
      return;
    }
    const data = (await res.json()) as { numbers: OfficialNumber[] };
    setNumbers(data.numbers);
    setSelected((current) => {
      // null = "just added one": select it (the newest is listed last).
      if (select === null) return data.numbers.at(-1)?.id ?? null;
      if (select !== undefined) return select;
      if (
        current &&
        current !== 'new' &&
        data.numbers.some((n) => n.id === current)
      )
        return current;
      return data.numbers[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function makePrimary(id: string) {
    setBusy(id);
    try {
      const res = await fetch('/api/whatsapp/numbers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, primary: true }),
      });
      if (!res.ok) {
        toast.error(t('primaryFailed'));
        return;
      }
      toast.success(t('primaryDone'));
      await load(id);
    } finally {
      setBusy(null);
    }
  }

  if (numbers === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  // No number yet: the plain form, exactly as before.
  if (numbers.length === 0) {
    return <WhatsAppConfig onChanged={() => load()} />;
  }

  const header = (
    <div className="border-border mb-6 space-y-2 rounded-2xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-foreground text-sm font-medium">{t('title')}</p>
          <p className="text-muted-foreground text-xs">{t('hint')}</p>
        </div>
        {canEditSettings && (
          <Button
            size="sm"
            variant={selected === 'new' ? 'default' : 'outline'}
            onClick={() => setSelected('new')}
          >
            <Plus className="size-4" />
            {t('add')}
          </Button>
        )}
      </div>
      <ul className="divide-border divide-y">
        {numbers.map((n) => (
          <li key={n.id} className="flex flex-wrap items-center gap-2 py-2">
            <button
              type="button"
              onClick={() => setSelected(n.id)}
              aria-pressed={selected === n.id}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                selected === n.id ? 'bg-muted' : 'hover:bg-muted/60'
              )}
            >
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  n.status === 'connected' && !n.health_error
                    ? 'bg-emerald-500'
                    : 'bg-amber-500'
                )}
                aria-hidden
              />
              <span className="text-foreground truncate text-sm font-medium">
                {n.label || t('unnamed')}
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {n.display_phone_number || n.phone_number_id}
              </span>
              {n.is_primary && (
                <span className="bg-foreground/10 text-foreground rounded-full px-2 py-0.5 text-[10px] font-semibold">
                  {t('primary')}
                </span>
              )}
              {n.health_error && (
                <span
                  className="truncate text-[11px] text-amber-700 dark:text-amber-300"
                  title={n.health_error}
                >
                  {t('healthFailing')}
                </span>
              )}
            </button>
            {!n.is_primary && canEditSettings && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === n.id}
                onClick={() => makePrimary(n.id)}
              >
                {busy === n.id ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Star className="size-3.5" />
                )}
                {t('makePrimary')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <WhatsAppConfig
      key={selected ?? 'primary'}
      configId={selected === 'new' ? null : selected}
      addNew={selected === 'new'}
      header={header}
      onChanged={() => load(selected === 'new' ? null : undefined)}
    />
  );
}
