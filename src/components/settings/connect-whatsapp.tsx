'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Loader2,
  MessageCircle,
  Smartphone,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * "Connect WhatsApp" through Meta's hosted Embedded Signup
 * (specs/whatsapp-coexistence.md). One click opens Meta's page in a small
 * popup; the customer logs in with Facebook and, for a number on the
 * WhatsApp Business app, scans a QR. The number shows up here when Meta's
 * webhook arrives — no token to paste.
 *
 * `manual` is the token form: folded under "advanced" when the hosted
 * signup is available, shown as-is when it is not (self-hosted installs).
 * `compact` (the account already has numbers) folds the card to one line.
 */

type Mode = 'coexistence' | 'api';

interface Signup {
  id: string;
  status: 'waiting' | 'connected' | 'unmatched' | 'failed';
  display_phone_number: string | null;
  error: string | null;
  created_at: string;
}

/** The picture of each option (public/whatsapp, generated art). */
const MODE_ART = {
  coexistence: '/whatsapp/connect-app.webp',
  api: '/whatsapp/connect-api.webp',
} as const;

const POLL_MS = 3_000;
/** Meta's webhook can land a little after the popup closes. */
const AFTER_CLOSE_MS = 20_000;
/** An open request older than this is shown as expired. */
const WAIT_LIMIT_MS = 15 * 60_000;

function popupFeatures() {
  const w = 600;
  const h = 760;
  const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
  return `popup,width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)}`;
}

export function ConnectWhatsApp({
  onConnected,
  compact = false,
  manual,
}: {
  onConnected: () => void;
  compact?: boolean;
  manual?: ReactNode;
}) {
  const t = useTranslations('Settings.whatsapp.connect');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [latest, setLatest] = useState<Signup | null>(null);
  const [busy, setBusy] = useState<Mode | null>(null);
  const [open, setOpen] = useState(!compact);
  const [now, setNow] = useState(() => Date.now());
  const popup = useRef<Window | null>(null);
  const closedAt = useRef<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/whatsapp/signup', { cache: 'no-store' });
    if (!res.ok) {
      setAvailable(false);
      return null;
    }
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

  const waiting =
    latest?.status === 'waiting' &&
    now - new Date(latest.created_at).getTime() < WAIT_LIMIT_MS;

  const cancel = useCallback(async () => {
    popup.current?.close();
    popup.current = null;
    closedAt.current = null;
    await fetch('/api/whatsapp/signup', { method: 'DELETE' });
    await load();
  }, [load]);

  // While waiting: poll for Meta's webhook, and notice the popup closing.
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(async () => {
      setNow(Date.now());
      const next = await load();
      if (next?.status === 'connected') {
        popup.current?.close();
        popup.current = null;
        toast.success(t('connected'));
        onConnected();
        return;
      }
      if (popup.current?.closed && closedAt.current === null)
        closedAt.current = Date.now();
      if (
        closedAt.current !== null &&
        Date.now() - closedAt.current > AFTER_CLOSE_MS
      ) {
        toast.message(t('closed'));
        await cancel();
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [waiting, load, cancel, onConnected, t]);

  async function start(mode: Mode) {
    setBusy(mode);
    // Opened inside the click so the browser allows it; the URL comes next.
    const win = window.open('', 'meta-whatsapp-signup', popupFeatures());
    try {
      const res = await fetch('/api/whatsapp/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        win?.close();
        toast.error(
          t(
            data.error === 'number_limit'
              ? 'error.number_limit'
              : 'error.generic'
          )
        );
        return;
      }
      if (!win) {
        toast.error(t('popupBlocked'));
        await fetch('/api/whatsapp/signup', { method: 'DELETE' });
        return;
      }
      win.location.href = data.url;
      win.focus();
      popup.current = win;
      closedAt.current = null;
      setNow(Date.now());
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (available === null) {
    return (
      <div
        className="bg-muted mb-6 h-24 animate-pulse rounded-2xl"
        aria-hidden
      />
    );
  }
  if (!available) return <>{manual}</>;

  const status =
    latest && (latest.status !== 'failed' || latest.error !== 'replaced')
      ? latest
      : null;

  return (
    <>
      <section className="border-border mb-6 rounded-2xl border p-4">
        <button
          type="button"
          onClick={() => compact && setOpen((o) => !o)}
          aria-expanded={open}
          className={cn(
            'flex w-full items-start gap-3 text-left',
            !compact && 'cursor-default'
          )}
        >
          <span className="bg-tone-mint-soft text-tone-mint-ink flex size-9 shrink-0 items-center justify-center rounded-full">
            <Smartphone className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-foreground block text-sm font-semibold">
              {compact ? t('compactTitle') : t('title')}
            </span>
            <span className="text-muted-foreground block text-xs">
              {t('hint')}
            </span>
          </span>
          {compact && (
            <ChevronDown
              className={cn(
                'text-muted-foreground mt-1 size-4 transition-transform',
                open && 'rotate-180'
              )}
            />
          )}
        </button>

        {open && (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 lg:grid-cols-2">
              {(['coexistence', 'api'] as const).map((m) => {
                return (
                  <article
                    key={m}
                    className="border-border bg-card flex min-h-40 overflow-hidden rounded-2xl border"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- static art */}
                    <img
                      src={MODE_ART[m]}
                      alt=""
                      className={cn(
                        'hidden w-2/5 shrink-0 object-cover sm:block',
                        m === 'api' ? 'object-left' : 'object-center'
                      )}
                    />
                    <div className="flex flex-1 flex-col gap-2 p-4">
                      <span className="flex size-8 items-center justify-center rounded-lg bg-[#25D366]/15 text-[#128C4B] dark:text-[#5BE38F]">
                        <MessageCircle className="size-4" />
                      </span>
                      <h4 className="text-foreground text-sm font-semibold">
                        {t(`mode.${m}.title`)}
                      </h4>
                      <p className="text-muted-foreground text-xs">
                        {t(`mode.${m}.hint`)}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-auto self-start"
                        disabled={busy !== null || waiting}
                        onClick={() => start(m)}
                      >
                        {busy === m ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : null}
                        {t('start')}
                        <ArrowRight className="size-3.5" />
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>

            <details className="text-xs">
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
                {t('whatChanges')}
              </summary>
              <ul className="text-muted-foreground mt-2 list-disc space-y-1 pl-5">
                <li>{t('notes.app')}</li>
                <li>{t('notes.lost')}</li>
                <li>{t('notes.windows')}</li>
                <li>{t('notes.active')}</li>
              </ul>
            </details>
          </div>
        )}

        {status && (open || waiting) && (
          <div
            aria-live="polite"
            className={cn(
              'mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
              status.status === 'connected'
                ? 'bg-tone-mint-soft text-tone-mint-ink'
                : waiting
                  ? 'bg-muted text-foreground'
                  : 'bg-tone-salmon-soft text-tone-salmon-ink'
            )}
          >
            {status.status === 'connected' ? (
              <CheckCircle2 className="size-4 shrink-0" />
            ) : waiting ? (
              <Loader2 className="size-4 shrink-0 animate-spin" />
            ) : (
              <TriangleAlert className="size-4 shrink-0" />
            )}
            <span className="flex-1">
              {status.status === 'connected'
                ? t('status.connected', {
                    phone: status.display_phone_number ?? '',
                  })
                : waiting
                  ? t('status.waiting')
                  : status.status === 'waiting'
                    ? t('status.expired')
                    : status.error === 'cancelled'
                      ? t('status.cancelled')
                      : status.error === 'number_limit'
                        ? t('error.number_limit')
                        : t('status.failed')}
            </span>
            {waiting && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={cancel}
              >
                <X className="size-3.5" />
                {t('cancel')}
              </Button>
            )}
          </div>
        )}
      </section>

      {manual && (
        <details className="group mb-6">
          <summary className="text-muted-foreground hover:text-foreground mb-4 cursor-pointer text-sm">
            {t('manual')}
          </summary>
          {manual}
        </details>
      )}
    </>
  );
}
