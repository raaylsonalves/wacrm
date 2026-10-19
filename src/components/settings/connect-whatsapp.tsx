'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Smartphone, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * "Connect WhatsApp" through Meta's hosted Embedded Signup
 * (specs/whatsapp-coexistence.md). The customer types the number, opens
 * Meta's page, scans the QR in the WhatsApp Business app, and the number
 * shows up here when Meta's webhook arrives — no token to paste.
 * Renders nothing on installs without the hosted signup configured.
 */

type Mode = 'coexistence' | 'api';

interface Signup {
  id: string;
  phone_digits: string | null;
  mode: Mode;
  status: 'waiting' | 'connected' | 'unmatched' | 'failed';
  display_phone_number: string | null;
  error: string | null;
  created_at: string;
}

const POLL_MS = 5_000;
/** Stop polling a request after this long; the customer can retry. */
const WAIT_LIMIT_MS = 30 * 60_000;

export function ConnectWhatsApp({ onConnected }: { onConnected: () => void }) {
  const t = useTranslations('Settings.whatsapp.connect');
  const [available, setAvailable] = useState(false);
  const [latest, setLatest] = useState<Signup | null>(null);
  const [phone, setPhone] = useState('');
  const [mode, setMode] = useState<Mode>('coexistence');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/whatsapp/signup', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      available: boolean;
      signups: Signup[];
    };
    setAvailable(data.available);
    const first = data.signups.find((s) => s.error !== 'replaced') ?? null;
    setLatest(first);
    return first;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a request waits, poll until Meta's webhook settles it.
  const waiting =
    latest?.status === 'waiting' &&
    Date.now() - new Date(latest.created_at).getTime() < WAIT_LIMIT_MS;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(async () => {
      const next = await load();
      if (next?.status === 'connected') {
        toast.success(t('connected'));
        onConnected();
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [waiting, load, onConnected, t]);

  async function start() {
    setBusy(true);
    // Opened before the request so the browser treats it as the click's
    // own popup; the URL is filled in once we have it.
    const win = window.open('', '_blank');
    try {
      const res = await fetch('/api/whatsapp/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, mode }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        win?.close();
        toast.error(
          t(
            `error.${data.error === 'invalid_phone' || data.error === 'number_limit' ? data.error : 'generic'}`
          )
        );
        return;
      }
      if (win) win.location.href = data.url;
      else window.location.href = data.url;
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!available) return null;

  return (
    <section className="border-border mb-6 space-y-4 rounded-2xl border p-4">
      <div className="flex items-start gap-3">
        <span className="bg-tone-mint-soft text-tone-mint-ink flex size-9 shrink-0 items-center justify-center rounded-full">
          <Smartphone className="size-4" />
        </span>
        <div>
          <h3 className="text-foreground text-sm font-semibold">
            {t('title')}
          </h3>
          <p className="text-muted-foreground text-xs">{t('hint')}</p>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={t('modeLabel')}
        className="grid gap-2 sm:grid-cols-2"
      >
        {(['coexistence', 'api'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              'rounded-xl border p-3 text-left transition-colors',
              mode === m
                ? 'border-foreground bg-muted'
                : 'border-border hover:bg-muted/60'
            )}
          >
            <span className="text-foreground block text-sm font-medium">
              {t(`mode.${m}.title`)}
            </span>
            <span className="text-muted-foreground block text-xs">
              {t(`mode.${m}.hint`)}
            </span>
          </button>
        ))}
      </div>

      {mode === 'coexistence' && (
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
          <li>{t('notes.app')}</li>
          <li>{t('notes.lost')}</li>
          <li>{t('notes.windows')}</li>
          <li>{t('notes.active')}</li>
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[14rem] flex-1 space-y-1">
          <span className="text-foreground text-xs font-medium">
            {t('phoneLabel')}
          </span>
          <Input
            inputMode="tel"
            autoComplete="tel"
            placeholder={t('phonePlaceholder')}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <Button
          onClick={start}
          disabled={busy || phone.replace(/\D/g, '').length < 10}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t('start')}
        </Button>
      </div>

      {latest && (
        <p
          aria-live="polite"
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
            latest.status === 'connected'
              ? 'bg-tone-mint-soft text-tone-mint-ink'
              : latest.status === 'waiting'
                ? 'bg-muted text-foreground'
                : 'bg-tone-salmon-soft text-tone-salmon-ink'
          )}
        >
          {latest.status === 'connected' ? (
            <CheckCircle2 className="size-4 shrink-0" />
          ) : latest.status === 'waiting' ? (
            <Loader2
              className={cn('size-4 shrink-0', waiting && 'animate-spin')}
            />
          ) : (
            <TriangleAlert className="size-4 shrink-0" />
          )}
          {latest.status === 'waiting'
            ? waiting
              ? t('status.waiting', { phone: latest.phone_digits ?? '' })
              : t('status.expired')
            : latest.status === 'connected'
              ? t('status.connected', {
                  phone:
                    latest.display_phone_number ?? latest.phone_digits ?? '',
                })
              : latest.error === 'number_limit'
                ? t('error.number_limit')
                : t('status.failed')}
        </p>
      )}
    </section>
  );
}
