'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Minus, X } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { formatRelative } from '@/lib/automations/trigger-meta';
import { TONE_SOLID, TONE_SOFT, toneFor } from '@/lib/tones';
import { cn } from '@/lib/utils';
import { SidePanel } from '@/components/ui/side-panel';
import { SkeletonList } from '@/components/ui/skeleton';
import type { AutomationLog, AutomationLogStepResult } from '@/types';
import { STEP_META, GROUP_TONE } from './step-meta';

type Filter = 'all' | 'failed';

const RUN_TONE: Record<AutomationLog['status'], string> = {
  success: TONE_SOFT.mint,
  partial: TONE_SOFT.salmon,
  failed: 'bg-tone-pink-soft text-tone-pink-ink',
};

/**
 * Activepieces-style "Runs": every time the automation fired, who it ran
 * for and how it went, newest first. A run opens in the side panel as a
 * step-by-step timeline. Reads automation_logs (RLS-scoped) — the same
 * rows the old /logs page listed.
 */
export function AutomationRuns({ automationId }: { automationId: string }) {
  const t = useTranslations('Automations.logs');
  const tRuns = useTranslations('Automations.runs');
  const tRelative = useTranslations('Automations.relative');
  const tBuilder = useTranslations('Automations.builder');
  const [logs, setLogs] = useState<AutomationLog[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    createClient()
      .from('automation_logs')
      .select('*, contact:contacts(id, name, phone)')
      .eq('automation_id', automationId)
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data, error: err }) => {
        if (!alive) return;
        if (err) setError(true);
        else setLogs((data ?? []) as AutomationLog[]);
      });
    return () => {
      alive = false;
    };
  }, [automationId]);

  const stats = useMemo(() => {
    const all = logs ?? [];
    const ok = all.filter((l) => l.status === 'success').length;
    return {
      total: all.length,
      failed: all.filter((l) => l.status !== 'success').length,
      rate: all.length ? Math.round((ok / all.length) * 100) : null,
    };
  }, [logs]);

  const shown = (logs ?? []).filter(
    (l) => filter === 'all' || l.status !== 'success'
  );
  const open = (logs ?? []).find((l) => l.id === openId) ?? null;

  if (error) {
    return (
      <p className="text-tone-pink-ink p-8 text-center text-sm">
        {t('loadError')}
      </p>
    );
  }

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8 transition-[padding] duration-200 ease-out',
        open && 'lg:max-w-none lg:pr-[468px] lg:pl-8'
      )}
    >
      {logs === null ? (
        <SkeletonList rows={6} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5">
            <Stat label={tRuns('total')} value={String(stats.total)} />
            <Stat
              label={tRuns('successRate')}
              value={stats.rate === null ? '—' : `${stats.rate}%`}
            />
            <Stat label={tRuns('withProblems')} value={String(stats.failed)} />
          </div>

          <div className="flex gap-1.5">
            {(['all', 'failed'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'min-h-9 rounded-full border px-4 text-[13px] font-semibold transition-colors duration-150 ease-out',
                  filter === f
                    ? 'bg-foreground text-background border-transparent'
                    : 'border-border hover:bg-card'
                )}
              >
                {tRuns(`filter.${f}`)}
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <div className="border-border bg-card flex flex-col items-center justify-center gap-1 rounded-[22px] border border-dashed px-6 py-12 text-center">
              <p className="text-sm font-semibold">
                {filter === 'failed' ? tRuns('noProblems') : t('emptyTitle')}
              </p>
              {filter === 'all' && (
                <p className="text-muted-foreground text-xs">
                  {t('emptyDesc')}
                </p>
              )}
            </div>
          ) : (
            <ul className="stagger flex flex-col gap-2">
              {shown.map((log) => {
                const who =
                  log.contact?.name ??
                  log.contact?.phone ??
                  t('unknownContact');
                const n = log.steps_executed?.length ?? 0;
                return (
                  <li key={log.id}>
                    <button
                      type="button"
                      onClick={() =>
                        setOpenId(openId === log.id ? null : log.id)
                      }
                      aria-pressed={openId === log.id}
                      className={cn(
                        'border-border bg-card flex w-full items-center gap-3 rounded-[20px] border p-3 text-left transition-[box-shadow,transform] duration-150 ease-out hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgb(0_0_0/0.08)]',
                        openId === log.id && 'ring-foreground ring-2'
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-10 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                          TONE_SOLID[toneFor(who)]
                        )}
                      >
                        {initials(who)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold">
                          {who}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {triggerLabel(tBuilder, log.trigger_event)} ·{' '}
                          {tRuns('steps', { count: n })}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[11px] font-bold first-letter:uppercase',
                            RUN_TONE[log.status]
                          )}
                        >
                          {t(`status.${log.status}`)}
                        </span>
                        <span className="text-muted-foreground text-[11px]">
                          {formatRelative(log.created_at, tRelative)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <SidePanel
        open={!!open}
        onClose={() => setOpenId(null)}
        label={tRuns('runDetail')}
        className="top-[76px]"
      >
        {open && (
          <RunDetail
            log={open}
            onClose={() => setOpenId(null)}
            t={t}
            tRuns={tRuns}
            tBuilder={tBuilder}
            tRelative={tRelative}
          />
        )}
      </SidePanel>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-card rounded-[20px] border px-4 py-3">
      <div className="text-muted-foreground text-xs font-semibold">{label}</div>
      <div className="text-xl font-extrabold tabular-nums">{value}</div>
    </div>
  );
}

function RunDetail({
  log,
  onClose,
  t,
  tRuns,
  tBuilder,
  tRelative,
}: {
  log: AutomationLog;
  onClose: () => void;
  t: ReturnType<typeof useTranslations>;
  tRuns: ReturnType<typeof useTranslations>;
  tBuilder: ReturnType<typeof useTranslations>;
  tRelative: ReturnType<typeof useTranslations>;
}) {
  const who = log.contact?.name ?? log.contact?.phone ?? t('unknownContact');
  const steps = log.steps_executed ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-2 px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <span
            className={cn(
              'inline-block rounded-full px-2 py-0.5 text-[11px] font-bold first-letter:uppercase',
              RUN_TONE[log.status]
            )}
          >
            {t(`status.${log.status}`)}
          </span>
          <h2 className="mt-1.5 truncate text-lg font-extrabold tracking-[-0.01em]">
            {who}
          </h2>
          <p className="text-muted-foreground text-xs">
            {triggerLabel(tBuilder, log.trigger_event)} ·{' '}
            {new Date(log.created_at).toLocaleString()} ·{' '}
            {formatRelative(log.created_at, tRelative)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={tBuilder('close')}
          className="hover:bg-muted flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ease-out"
        >
          <X className="size-4.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {log.error_message && (
          <p className="bg-tone-pink-soft text-tone-pink-ink mb-4 rounded-2xl px-3 py-2.5 text-xs leading-relaxed">
            {log.error_message}
          </p>
        )}
        {steps.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noSteps')}</p>
        ) : (
          <ol className="relative flex flex-col gap-3">
            {/* the timeline rail */}
            <span
              className="bg-border absolute top-5 bottom-5 left-5 w-[2px]"
              aria-hidden
            />
            {steps.map((r, i) => (
              <TimelineStep
                key={i}
                index={i}
                result={r}
                t={t}
                tRuns={tRuns}
                tBuilder={tBuilder}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function TimelineStep({
  index,
  result,
  t,
  tRuns,
  tBuilder,
}: {
  index: number;
  result: AutomationLogStepResult;
  t: ReturnType<typeof useTranslations>;
  tRuns: ReturnType<typeof useTranslations>;
  tBuilder: ReturnType<typeof useTranslations>;
}) {
  const meta = STEP_META[result.step_type];
  const Icon = meta?.icon;
  const detail = stepDetailText(t, tBuilder, result.detail);
  const StatusIcon =
    result.status === 'success'
      ? Check
      : result.status === 'failed'
        ? X
        : Minus;
  return (
    <li className="relative flex items-start gap-3">
      <span
        className={cn(
          'relative z-10 flex size-10 shrink-0 items-center justify-center rounded-xl',
          meta ? GROUP_TONE[meta.group] : 'bg-muted'
        )}
      >
        {Icon && <Icon className="size-[18px]" />}
        <span
          className={cn(
            'border-card absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full border-2',
            result.status === 'success'
              ? 'bg-tone-mint text-tone-on'
              : result.status === 'failed'
                ? 'bg-tone-pink-ink text-white'
                : 'bg-muted text-muted-foreground'
          )}
          aria-hidden
        >
          <StatusIcon className="size-2.5" strokeWidth={3} />
        </span>
      </span>
      <div className="border-border bg-card min-w-0 flex-1 rounded-2xl border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[11px] font-bold">
            {tBuilder('stepN', { n: index + 1 })}
          </span>
          <span
            className={cn(
              'text-[11px] font-bold',
              result.status === 'failed'
                ? 'text-tone-pink-ink'
                : 'text-muted-foreground'
            )}
          >
            {tRuns(`stepStatus.${result.status}`)}
          </span>
        </div>
        <div className="text-sm font-bold">
          {tBuilder.has(`steps.${result.step_type}`)
            ? tBuilder(`steps.${result.step_type}`)
            : result.step_type}
        </div>
        {detail && (
          <div className="text-muted-foreground mt-0.5 text-xs break-words">
            {detail}
          </div>
        )}
      </div>
    </li>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

// Labels come from the builder catalogue; unknown (future) ids fall back
// to the raw value so an old build never throws on a newer log row.
function triggerLabel(
  tBuilder: ReturnType<typeof useTranslations>,
  triggerEvent: string
): string {
  const key = `triggers.${triggerEvent}.label`;
  return tBuilder.has(key) ? tBuilder(key) : triggerEvent;
}

// Structured details (specs/i18n-automation-step-detail.md) translate via
// `Automations.logs.stepDetail.<key>`; a `unit` param is itself a key
// (`minutes`/`hours`/`days`) resolved through the builder's unit labels.
// Legacy rows stored a plain string — shown verbatim.
function stepDetailText(
  t: ReturnType<typeof useTranslations>,
  tBuilder: ReturnType<typeof useTranslations>,
  detail: AutomationLogStepResult['detail']
): string | null {
  if (!detail) return null;
  if (typeof detail === 'string') return detail;
  const key = `stepDetail.${detail.key}`;
  if (!t.has(key)) return null;
  const params = { ...detail.params };
  if (typeof params.unit === 'string') {
    const unitKey = `config.units.${params.unit}`;
    params.unit = tBuilder.has(unitKey) ? tBuilder(unitKey) : params.unit;
  }
  return t(key, params);
}
