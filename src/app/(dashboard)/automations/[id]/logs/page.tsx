'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Loader2,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import type {
  Automation,
  AutomationLog,
  AutomationLogStepResult,
} from '@/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatRelative } from '@/lib/automations/trigger-meta';

export default function AutomationLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const t = useTranslations('Automations.logs');
  const tRelative = useTranslations('Automations.relative');
  const tBuilder = useTranslations('Automations.builder');

  const [automation, setAutomation] = useState<Automation | null>(null);
  const [logs, setLogs] = useState<AutomationLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openLogId, setOpenLogId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient();
        const [autRes, logRes] = await Promise.all([
          supabase.from('automations').select('*').eq('id', id).maybeSingle(),
          supabase
            .from('automation_logs')
            .select('*, contact:contacts(id, name, phone)')
            .eq('automation_id', id)
            .order('created_at', { ascending: false })
            .limit(100),
        ]);
        if (autRes.error) throw autRes.error;
        if (logRes.error) throw logRes.error;
        setAutomation(autRes.data as Automation | null);
        setLogs((logRes.data ?? []) as AutomationLog[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('loadError'));
      }
    }
    load();
  }, [id]);

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <Button variant="outline" onClick={() => router.push('/automations')}>
          {t('back')}
        </Button>
      </div>
    );
  }

  if (!automation || logs === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.push('/automations')}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded-md transition-colors"
          aria-label={t('backAria')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="text-foreground text-2xl font-bold">
            {automation.name}
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">{t('title')}</p>
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="border-border bg-card/40 flex h-48 flex-col items-center justify-center rounded-xl border border-dashed">
          <p className="text-foreground text-sm">{t('emptyTitle')}</p>
          <p className="text-muted-foreground mt-1 text-xs">{t('emptyDesc')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {logs.map((log) => {
            const isOpen = openLogId === log.id;
            return (
              <li
                key={log.id}
                className="border-border bg-card rounded-xl border"
              >
                <button
                  type="button"
                  onClick={() => setOpenLogId(isOpen ? null : log.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="text-muted-foreground h-4 w-4" />
                  ) : (
                    <ChevronRight className="text-muted-foreground h-4 w-4" />
                  )}
                  <StatusBadge status={log.status} t={t} />
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground truncate text-sm font-medium">
                      {log.contact?.name ??
                        log.contact?.phone ??
                        t('unknownContact')}
                    </div>
                    <div className="text-muted-foreground truncate text-xs">
                      {triggerLabel(tBuilder, log.trigger_event)} ·{' '}
                      {log.steps_executed?.length ?? 0}{' '}
                      {log.steps_executed?.length === 1
                        ? t('step', { count: 1 }).replace('1 ', '')
                        : t('stepPlural', {
                            count: log.steps_executed?.length ?? 0,
                          }).replace(/^[0-9]+ /, '')}
                    </div>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {formatRelative(log.created_at, tRelative)}
                  </div>
                </button>
                {isOpen && (
                  <div className="border-border border-t px-4 py-3">
                    {log.error_message && (
                      <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                        {log.error_message}
                      </p>
                    )}
                    <ul className="space-y-1.5">
                      {(log.steps_executed ?? []).map((r, i) => (
                        <StepRow key={i} result={r} t={t} tBuilder={tBuilder} />
                      ))}
                      {(log.steps_executed ?? []).length === 0 && (
                        <li className="text-muted-foreground text-xs">
                          {t('noSteps')}
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: AutomationLog['status'];
  t: ReturnType<typeof useTranslations>;
}) {
  const classes =
    status === 'success'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : status === 'partial'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        classes
      )}
    >
      {t(`status.${status}`)}
    </span>
  );
}

// Both catalogues (`Automations.builder.triggers.<id>.label` /
// `.steps.<id>`) exist for the automation builder UI, but the labels
// are exactly what the log list needs too — falls back to the raw
// enum value for anything not in the catalogue (future step/trigger
// types) so this never throws on a stale build.
function triggerLabel(
  tBuilder: ReturnType<typeof useTranslations>,
  triggerEvent: string
): string {
  const key = `triggers.${triggerEvent}.label`;
  return tBuilder.has(key) ? tBuilder(key) : triggerEvent;
}

function stepLabel(
  tBuilder: ReturnType<typeof useTranslations>,
  stepType: string
): string {
  const key = `steps.${stepType}`;
  return tBuilder.has(key) ? tBuilder(key) : stepType;
}

// Structured details (specs/i18n-automation-step-detail.md) translate
// via `Automations.logs.stepDetail.<key>`; the "unit" param on `wait`
// is itself a translation key (`minutes`/`hours`/`days`) rather than
// already-translated text, so it's resolved separately through
// `Automations.builder.config.units.*` — the same catalogue the step
// config form already uses for that label — before interpolation.
function stepDetailText(
  t: ReturnType<typeof useTranslations>,
  tBuilder: ReturnType<typeof useTranslations>,
  detail: AutomationLogStepResult['detail']
): string | null {
  if (!detail) return null;
  // Legacy shape: a plain string written before this change. Render
  // verbatim rather than crashing — it just won't be translated.
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

function StepRow({
  result,
  t,
  tBuilder,
}: {
  result: AutomationLogStepResult;
  t: ReturnType<typeof useTranslations>;
  tBuilder: ReturnType<typeof useTranslations>;
}) {
  const ok = result.status === 'success';
  const detailText = stepDetailText(t, tBuilder, result.detail);
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={cn(
          'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full',
          ok
            ? 'bg-primary/20 text-primary'
            : 'bg-red-500/20 text-red-600 dark:text-red-400'
        )}
        aria-hidden
      >
        {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </span>
      <span className="text-muted-foreground">
        {stepLabel(tBuilder, result.step_type)}
      </span>
      {detailText && (
        <span className="text-muted-foreground truncate">— {detailText}</span>
      )}
    </li>
  );
}
