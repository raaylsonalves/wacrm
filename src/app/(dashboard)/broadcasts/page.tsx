'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast } from '@/types';
import { Button } from '@/components/ui/button';
import { Radio, Plus } from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { getBroadcastStatus } from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';
import { APP_LOCALE } from '@/lib/currency';
import { SkeletonPage } from '@/components/ui/skeleton';

/**
 * Poll cadence while any broadcast is sending. Kept modest so we don't
 * beat on Supabase — the aggregate trigger in migration 003 keeps
 * counts consistent; we just need to surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 5_000;

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function RateBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  /** Tailwind bg class for the fill. */
  color: string;
}) {
  const pct = percent(value, total);
  return (
    <div className="min-w-0 flex-1">
      <div className="text-muted-foreground flex items-baseline justify-between gap-2 text-[11.5px] font-semibold">
        <span className="truncate">{label}</span>
        <span className="text-foreground tabular-nums">{pct}%</span>
      </div>
      <div className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-card rounded-[20px] border px-4 py-3">
      <div className="text-muted-foreground truncate text-xs font-semibold">
        {label}
      </div>
      <div className="text-xl font-extrabold tabular-nums">{value}</div>
    </div>
  );
}

export default function BroadcastsPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.page');
  const tStatus = useTranslations('Broadcasts.status');
  const canCreate = useCan('send-messages');
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Used to kick off polling only while something is actively sending.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchBroadcasts() {
    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from('broadcasts')
        .select('*')
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      setBroadcasts(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorLoad'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBroadcasts();
  }, []);

  const stats = useMemo(() => {
    const sent = broadcasts.filter((b) => b.total_recipients > 0);
    const recipients = sent.reduce((n, b) => n + b.total_recipients, 0);
    const read = sent.reduce((n, b) => n + b.read_count, 0);
    return {
      total: broadcasts.length,
      recipients,
      readRate: recipients ? `${percent(read, recipients)}%` : '—',
    };
  }, [broadcasts]);

  const anySending = useMemo(
    () => broadcasts.some((b) => b.status === 'sending'),
    [broadcasts],
  );

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(fetchBroadcasts, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    // Pause polling while the tab is hidden — keeps Supabase cold when
    // the user is away, and ensures a fresh fetch the moment they
    // refocus so they don't see stale data on return.
    function handleVisibilityChange() {
      if (!anySending) return;
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        fetchBroadcasts();
        startPolling();
      }
    }

    if (anySending && document.visibilityState === 'visible') {
      startPolling();
    } else {
      stopPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [anySending]);

  if (loading) {
    return (
<SkeletonPage variant="table" />
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top indeterminate progress bar: only visible while a broadcast
          is mid-send. Pure CSS animation so no extra deps. */}
      {anySending && (
        <div
          role="progressbar"
          aria-label={t('broadcastInProgress')}
          className="broadcast-indeterminate fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-muted"
        >
          <div className="broadcast-indeterminate-bar bg-foreground h-0.5" />
          <style jsx>{`
            .broadcast-indeterminate-bar {
              width: 33%;
              transform: translateX(-100%);
              animation: broadcast-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1)
                infinite;
            }
            @keyframes broadcast-slide {
              0% {
                transform: translateX(-100%);
              }
              100% {
                transform: translateX(400%);
              }
            }
          `}</style>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-foreground text-[26px] leading-tight font-bold tracking-[-0.02em] lg:text-[28px]">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="createBroadcasts"
          onClick={() => router.push('/broadcasts/new')}
          className="bg-foreground text-background hover:bg-foreground/90"
        >
          <Plus className="h-4 w-4" />
          {t('newBroadcast')}
        </GatedButton>
      </div>

      {broadcasts.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Radio className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('noBroadcastsYet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('createFirst')}
          </p>
          <GatedButton
            canAct={canCreate}
            gateReason="createBroadcasts"
            onClick={() => router.push('/broadcasts/new')}
            className="mt-4 bg-foreground text-background hover:bg-foreground/90"
          >
            <Plus className="h-4 w-4" />
            {t('newBroadcast')}
          </GatedButton>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5">
            <Stat label={t('stats.total')} value={String(stats.total)} />
            <Stat
              label={t('stats.recipients')}
              value={stats.recipients.toLocaleString(APP_LOCALE)}
            />
            <Stat label={t('stats.readRate')} value={stats.readRate} />
          </div>
          <ul className="stagger grid gap-2.5 xl:grid-cols-2">
            {broadcasts.map((broadcast) => {
              const status = getBroadcastStatus(broadcast.status);
              return (
                <li key={broadcast.id}>
                  <button
                    type="button"
                    onClick={() => router.push(`/broadcasts/${broadcast.id}`)}
                    className="border-border bg-card flex w-full flex-col gap-3 rounded-[22px] border p-4 text-left transition-[box-shadow,transform] duration-150 ease-out hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgb(0_0_0/0.08)]"
                  >
                    <div className="flex w-full items-start gap-3">
                      <span className="bg-tone-lilac-soft text-tone-lilac-ink flex size-10 shrink-0 items-center justify-center rounded-xl">
                        <Radio className="size-[18px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold">
                          {broadcast.name}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {broadcast.template_name}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold ${status.classes}`}
                        >
                          {status.pulse && (
                            <span className="relative flex size-1.5">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
                              <span className="relative inline-flex size-1.5 rounded-full bg-current" />
                            </span>
                          )}
                          {tStatus(status.label)}
                        </span>
                        <span className="text-muted-foreground text-[11px]">
                          {broadcast.status === 'scheduled' &&
                          broadcast.scheduled_at
                            ? new Date(broadcast.scheduled_at).toLocaleString(
                                APP_LOCALE,
                                { dateStyle: 'short', timeStyle: 'short' }
                              )
                            : new Date(broadcast.created_at).toLocaleDateString(
                                APP_LOCALE
                              )}
                        </span>
                      </span>
                    </div>
                    <div className="flex w-full items-end gap-4">
                      <div className="shrink-0">
                        <div className="text-muted-foreground text-[11.5px] font-semibold">
                          {t('table.recipients')}
                        </div>
                        <div className="text-sm font-extrabold tabular-nums">
                          {broadcast.total_recipients.toLocaleString(APP_LOCALE)}
                        </div>
                      </div>
                      <RateBar
                        label={t('table.delivery')}
                        value={broadcast.delivered_count}
                        total={broadcast.total_recipients}
                        color="bg-tone-mint"
                      />
                      <RateBar
                        label={t('table.read')}
                        value={broadcast.read_count}
                        total={broadcast.total_recipients}
                        color="bg-tone-blue"
                      />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
