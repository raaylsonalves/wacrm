'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import {
  CircleAlert,
  CircleCheck,
  Clock,
  MessageCircle,
  Play,
  Reply,
  UserPlus,
  X,
} from 'lucide-react';

import { dateFnsLocale } from '@/lib/date-fns-locale';
import { formatRelative } from '@/lib/automations/trigger-meta';
import { TONE_SOFT, TONE_SOLID, toneFor } from '@/lib/tones';
import { cn } from '@/lib/utils';
import { SidePanel } from '@/components/ui/side-panel';
import { SkeletonList } from '@/components/ui/skeleton';
import { NodeIconChip, type NodeType } from './shared';
import { useFlowEditor } from './flow-editor-state';

interface RunRow {
  id: string;
  status:
    | 'active'
    | 'completed'
    | 'handed_off'
    | 'timed_out'
    | 'paused_by_agent'
    | 'failed';
  current_node_key: string | null;
  started_at: string;
  ended_at: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  contact: { id: string; name: string | null; phone: string } | null;
}

interface EventRow {
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

type Filter = 'all' | 'failed';

const STATUS_KEY: Record<RunRow['status'], string> = {
  active: 'statusActive',
  completed: 'statusCompleted',
  handed_off: 'statusHandedOff',
  timed_out: 'statusTimedOut',
  paused_by_agent: 'statusPaused',
  failed: 'statusFailed',
};

const STATUS_TONE: Record<RunRow['status'], string> = {
  active: TONE_SOFT.blue,
  completed: TONE_SOFT.mint,
  handed_off: TONE_SOFT.salmon,
  timed_out: 'bg-muted text-muted-foreground',
  paused_by_agent: 'bg-muted text-muted-foreground',
  failed: 'bg-tone-pink-soft text-tone-pink-ink',
};

const PROBLEM = new Set<RunRow['status']>(['failed', 'timed_out']);

// Events without a node get a plain icon; node events show the node's own
// chip so the timeline reads like the canvas.
const EVENT_ICON: Record<string, typeof Play> = {
  started: Play,
  message_sent: MessageCircle,
  reply_received: Reply,
  captured: CircleCheck,
  fallback_fired: CircleAlert,
  handoff: UserPlus,
  timeout: Clock,
  error: CircleAlert,
  completed: CircleCheck,
};

/**
 * The flow's "Execuções" tab, in the automation runs' shape: stats, a
 * problems filter, one card per run, and a run opening in the side panel
 * as the engine's own event log rendered as a timeline.
 */
export function FlowRuns() {
  const { flow, state } = useFlowEditor();
  const t = useTranslations('Flows.logs');
  const tRuns = useTranslations('Flows.runs');
  const tRelative = useTranslations('Automations.relative');
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/flows/${flow.id}/runs`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((json: { runs: RunRow[]; events: EventRow[] }) => {
        if (!alive) return;
        setRuns(json.runs ?? []);
        setEvents(json.events ?? []);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [flow.id]);

  const stats = useMemo(() => {
    const all = runs ?? [];
    // A hand-off to a person is how many flows are meant to end (lead
    // capture, triage), so it counts as finished, not as a drop-off.
    const done = all.filter(
      (r) => r.status === 'completed' || r.status === 'handed_off'
    ).length;
    return {
      total: all.length,
      problems: all.filter((r) => PROBLEM.has(r.status)).length,
      rate: all.length ? Math.round((done / all.length) * 100) : null,
    };
  }, [runs]);

  const typeByKey = useMemo(
    () => new Map(state.nodes.map((n) => [n.node_key, n.node_type])),
    [state.nodes]
  );

  const shown = (runs ?? []).filter(
    (r) => filter === 'all' || PROBLEM.has(r.status)
  );
  const open = (runs ?? []).find((r) => r.id === openId) ?? null;

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
      {runs === null ? (
        <SkeletonList rows={6} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5">
            <Stat label={tRuns('total')} value={String(stats.total)} />
            <Stat
              label={tRuns('completedRate')}
              value={stats.rate === null ? '—' : `${stats.rate}%`}
            />
            <Stat
              label={tRuns('withProblems')}
              value={String(stats.problems)}
            />
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
            <div className="border-border bg-card rounded-[22px] border border-dashed px-6 py-12 text-center">
              <p className="text-muted-foreground text-sm">
                {filter === 'failed' ? tRuns('noProblems') : t('emptyState')}
              </p>
            </div>
          ) : (
            <ul className="stagger flex flex-col gap-2">
              {shown.map((run) => {
                const who =
                  run.contact?.name?.trim() ||
                  run.contact?.phone ||
                  t('unknownContact');
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() =>
                        setOpenId(openId === run.id ? null : run.id)
                      }
                      aria-pressed={openId === run.id}
                      className={cn(
                        'border-border bg-card flex w-full items-center gap-3 rounded-[20px] border p-3 text-left transition-[box-shadow,transform] duration-150 ease-out hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgb(0_0_0/0.08)]',
                        openId === run.id && 'ring-foreground ring-2'
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
                          {run.status === 'active' && run.current_node_key
                            ? t('atNode', { node: run.current_node_key })
                            : tRuns('events', {
                                count: events.filter(
                                  (e) => e.flow_run_id === run.id
                                ).length,
                              })}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[11px] font-bold',
                            STATUS_TONE[run.status]
                          )}
                        >
                          {t(STATUS_KEY[run.status])}
                        </span>
                        <span className="text-muted-foreground text-[11px]">
                          {formatRelative(run.started_at, tRelative)}
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
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-start gap-2 px-5 pt-4 pb-3">
              <div className="min-w-0 flex-1">
                <div className="text-muted-foreground text-[11.5px] font-bold">
                  {tRuns('runDetail')}
                </div>
                <div className="truncate text-lg font-extrabold tracking-tight">
                  {open.contact?.name?.trim() ||
                    open.contact?.phone ||
                    t('unknownContact')}
                </div>
                <div className="text-muted-foreground text-xs">
                  {t('started', {
                    time: format(new Date(open.started_at), 'PP p', {
                      locale: dateFnsLocale,
                    }),
                  })}
                  {open.reprompt_count > 0 &&
                    ` · ${t('reprompts', { count: open.reprompt_count })}`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                aria-label={tRuns('close')}
                className="hover:bg-muted flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ease-out"
              >
                <X className="size-4.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
              <RunTimeline
                events={events.filter((e) => e.flow_run_id === open.id)}
                typeByKey={typeByKey}
              />
              {Object.keys(open.vars).length > 0 && (
                <div className="mt-5">
                  <div className="text-muted-foreground mb-2 text-[12.5px] font-bold">
                    {t('capturedVars', {
                      count: Object.keys(open.vars).length,
                    })}
                  </div>
                  <dl className="border-border divide-border divide-y rounded-2xl border">
                    {Object.entries(open.vars).map(([k, v]) => (
                      <div key={k} className="flex gap-3 px-3 py-2 text-xs">
                        <dt className="text-muted-foreground w-28 shrink-0 truncate font-mono">
                          {k}
                        </dt>
                        <dd className="min-w-0 break-words">
                          {typeof v === 'string' ? v : JSON.stringify(v)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          </div>
        )}
      </SidePanel>
    </div>
  );
}

function RunTimeline({
  events,
  typeByKey,
}: {
  events: EventRow[];
  typeByKey: Map<string, NodeType>;
}) {
  const t = useTranslations('Flows.logs');
  const tRuns = useTranslations('Flows.runs');
  if (events.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('noEvents')}</p>;
  }
  return (
    <ol className="relative flex flex-col gap-3">
      <span
        className="bg-border absolute top-5 bottom-5 left-5 w-[2px]"
        aria-hidden
      />
      {events.map((ev, i) => {
        const nodeType = ev.node_key ? typeByKey.get(ev.node_key) : undefined;
        const bad =
          ev.event_type === 'error' || ev.event_type === 'fallback_fired';
        // The engine re-logs node_entered with the captured key once a
        // reply is stored — show that as what it means.
        const kind =
          ev.event_type === 'node_entered' && ev.payload.captured_key
            ? 'captured'
            : ev.event_type;
        const Icon = EVENT_ICON[kind] ?? Play;
        const label = tRuns.has(`event.${kind}`)
          ? tRuns(`event.${kind}`)
          : ev.event_type;
        const detail = summarizePayload(ev.payload);
        return (
          <li key={i} className="relative flex items-start gap-3">
            {kind === 'node_entered' && nodeType ? (
              <NodeIconChip
                type={nodeType}
                size={40}
                iconSize={18}
                className="relative z-10 rounded-xl"
              />
            ) : (
              <span
                className={cn(
                  'relative z-10 flex size-10 shrink-0 items-center justify-center rounded-xl',
                  bad ? 'bg-tone-pink-soft text-tone-pink-ink' : 'bg-muted'
                )}
              >
                <Icon className="size-[18px]" />
              </span>
            )}
            <div className="border-border bg-card min-w-0 flex-1 rounded-2xl border px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'text-sm font-bold',
                    bad && 'text-tone-pink-ink'
                  )}
                >
                  {label}
                </span>
                <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
                  {format(new Date(ev.created_at), 'HH:mm:ss')}
                </span>
              </div>
              {(ev.node_key || detail) && (
                <div className="text-muted-foreground mt-0.5 text-xs break-words">
                  {ev.node_key && (
                    <code className="font-mono">{ev.node_key}</code>
                  )}
                  {ev.node_key && detail && ' · '}
                  {detail}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
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

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

// The keys that matter most to a human reading the log; the full
// captured variables are listed under the timeline.
function summarizePayload(payload: Record<string, unknown>): string {
  for (const k of ['reply_id', 'captured_key', 'reason', 'advancing_to']) {
    const v = payload[k];
    if (v !== null && v !== undefined) return String(v).slice(0, 80);
  }
  return '';
}
