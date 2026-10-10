'use client';

// Atendimento — how fast leads are answered and by whom (migration 127).
// Data comes from two read-only RPCs under the user's RLS; every number
// is computed in lib/analytics/service.ts (unit-tested).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Bot,
  Clock,
  Download,
  Gauge,
  MessageCircleWarning,
  RefreshCw,
  UserPlus,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { fetchAllRows } from '@/lib/supabase/paginate';
import {
  arrivalsByHour,
  byDay,
  firstReplyMinutes,
  formatDuration,
  leadsCsv,
  perResponder,
  summarize,
  type LeadRow,
  type ReplyKind,
  type ResponseRow,
} from '@/lib/analytics/service';
import { BarChart } from '@/components/tremor/bar-chart';
import { MetricCard } from '@/components/dashboard/metric-card';
import { EmptyState } from '@/components/dashboard/empty-state';
import { SkeletonCard } from '@/components/dashboard/skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { APP_LOCALE } from '@/lib/currency';

type RangeDays = 7 | 30 | 90;
type LeadFilter = 'all' | 'late' | 'unanswered' | 'ai' | 'human';

export default function AnalyticsPage() {
  const t = useTranslations('Analytics');
  const { accountId, responseTimeTargetMinutes } = useAuth();
  const target = responseTimeTargetMinutes || 5;

  const [range, setRange] = useState<RangeDays>(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [responses, setResponses] = useState<ResponseRow[]>([]);
  const [people, setPeople] = useState<Map<string, string>>(new Map());
  const [numbers, setNumbers] = useState<Map<string, string>>(new Map());
  const [primaryLabel, setPrimaryLabel] = useState<string>('');
  const [filter, setFilter] = useState<LeadFilter>('all');

  const period = useMemo(() => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - range);
    from.setHours(0, 0, 0, 0);
    return { from, to };
    // reload re-reads "now"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, reload]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    const supabase = createClient();
    const args = {
      p_account_id: accountId,
      p_from: period.from.toISOString(),
      p_to: period.to.toISOString(),
    };
    setLoading(true);
    setError(false);
    Promise.all([
      fetchAllRows<LeadRow>((from, to) =>
        supabase.rpc('service_leads', args).range(from, to)
      ),
      fetchAllRows<ResponseRow>((from, to) =>
        supabase.rpc('service_responses', args).range(from, to)
      ),
      supabase.from('profiles').select('user_id, full_name').eq('account_id', accountId),
      supabase.from('whatsapp_config').select('id, label, display_phone_number, is_primary'),
      supabase.from('whatsapp_waha_channels').select('id, label'),
    ])
      .then(([l, r, profiles, configs, channels]) => {
        if (!alive) return;
        setLeads(l);
        setResponses(r);
        setPeople(
          new Map(
            (profiles.data ?? []).map((p) => [p.user_id as string, (p.full_name as string) || '—'])
          )
        );
        const n = new Map<string, string>();
        for (const c of configs.data ?? []) {
          const label = (c.label as string) || (c.display_phone_number as string) || 'WhatsApp';
          n.set(c.id as string, label);
          if (c.is_primary) setPrimaryLabel(label);
        }
        for (const c of channels.data ?? []) n.set(c.id as string, (c.label as string) || 'QR');
        setNumbers(n);
      })
      .catch(() => alive && setError(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [accountId, period]);

  const summary = useMemo(() => summarize(leads, target), [leads, target]);
  const days = useMemo(
    () => byDay(leads, responses, period.from, period.to),
    [leads, responses, period]
  );
  const hours = useMemo(() => arrivalsByHour(leads), [leads]);
  const responders = useMemo(() => perResponder(responses, target), [responses, target]);

  const kindLabel = (k: ReplyKind | null) =>
    k === 'ai' ? t('kind.ai') : k === 'human' ? t('kind.human') : k === 'automation' ? t('kind.automation') : t('kind.none');
  const whoLabel = (l: LeadRow) =>
    l.first_reply_kind === 'human' && l.first_reply_user_id
      ? people.get(l.first_reply_user_id) ?? '—'
      : kindLabel(l.first_reply_kind);
  const numberLabel = (l: LeadRow) =>
    (l.whatsapp_channel_id && numbers.get(l.whatsapp_channel_id)) ||
    (l.whatsapp_config_id && numbers.get(l.whatsapp_config_id)) ||
    primaryLabel;

  const filtered = leads.filter((l) => {
    const m = firstReplyMinutes(l);
    switch (filter) {
      case 'late':
        return m !== null && m > target;
      case 'unanswered':
        return m === null;
      case 'ai':
        return l.first_reply_kind === 'ai';
      case 'human':
        return l.first_reply_kind === 'human';
      default:
        return true;
    }
  });

  function exportCsv() {
    const csv = leadsCsv(
      filtered,
      [
        t('table.contact'),
        t('table.phone'),
        t('table.number'),
        t('table.arrived'),
        t('table.firstReplyAt'),
        t('table.minutes'),
        t('table.by'),
        t('table.who'),
      ],
      { kind: kindLabel, who: whoLabel, number: numberLabel }
    );
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `atendimento-${period.from.toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const dayLabel = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString(APP_LOCALE, { day: '2-digit', month: '2-digit' });
  const timeChart = days.map((d) => ({
    day: dayLabel(d.day),
    [t('kind.ai')]: d.ai ?? 0,
    [t('kind.human')]: d.human ?? 0,
  }));
  const leadsChart = days.map((d) => ({ day: dayLabel(d.day), [t('charts.leads')]: d.leads }));
  const hourChart = hours.map((n, h) => ({ hour: `${h}h`, [t('charts.leads')]: n }));
  const maxTime = Math.max(0, ...days.flatMap((d) => [d.ai ?? 0, d.human ?? 0]));

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-foreground text-xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle', { target })}</p>
        </div>
        <div className="flex items-center gap-2">
          {([7, 30, 90] as RangeDays[]).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={range === r ? 'default' : 'outline'}
              onClick={() => setRange(r)}
            >
              {t('range', { days: r })}
            </Button>
          ))}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('refresh')}
            onClick={() => setReload((n) => n + 1)}
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </header>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {t('loadError')}
        </p>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('kpi.leads')}
              value={String(summary.leads)}
              icon={UserPlus}
              tone="lilac"
              subtitle={t('kpi.unanswered', { count: summary.unanswered })}
            />
            <MetricCard
              title={t('kpi.firstReply')}
              value={formatDuration(summary.medianFirstMinutes)}
              icon={Clock}
              tone="blue"
              subtitle={t('kpi.average', { value: formatDuration(summary.avgFirstMinutes) })}
            />
            <MetricCard
              title={t('kpi.withinTarget', { target })}
              value={summary.withinTargetPct === null ? '—' : `${summary.withinTargetPct}%`}
              icon={Gauge}
              tone="mint"
              subtitle={t('kpi.ofAnswered', { count: summary.answered })}
            />
            <MetricCard
              title={t('kpi.aiFirst')}
              value={summary.aiFirstPct === null ? '—' : `${summary.aiFirstPct}%`}
              icon={Bot}
              tone="salmon"
              subtitle={t('kpi.aiFirstHint')}
            />
          </>
        )}
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('charts.timeTitle')} hint={t('charts.timeHint')}>
          {loading ? (
            <div className="bg-muted h-[240px] animate-pulse rounded-lg" />
          ) : maxTime === 0 ? (
            <EmptyState icon={Clock} title={t('empty')} />
          ) : (
            <BarChart
              data={timeChart}
              index="day"
              categories={[t('kind.ai'), t('kind.human')]}
              colors={['violet', 'cyan']}
              valueFormatter={(v) => formatDuration(v)}
              yAxisWidth={72}
              className="h-[240px]"
            />
          )}
        </Card>
        <Card title={t('charts.leadsTitle')} hint={t('charts.leadsHint')}>
          {loading ? (
            <div className="bg-muted h-[240px] animate-pulse rounded-lg" />
          ) : summary.leads === 0 ? (
            <EmptyState icon={UserPlus} title={t('empty')} />
          ) : (
            <BarChart
              data={leadsChart}
              index="day"
              categories={[t('charts.leads')]}
              colors={['emerald']}
              showLegend={false}
              allowDecimals={false}
              className="h-[240px]"
            />
          )}
        </Card>
        <Card title={t('charts.hoursTitle')} hint={t('charts.hoursHint')}>
          {loading ? (
            <div className="bg-muted h-[240px] animate-pulse rounded-lg" />
          ) : summary.leads === 0 ? (
            <EmptyState icon={UserPlus} title={t('empty')} />
          ) : (
            <BarChart
              data={hourChart}
              index="hour"
              categories={[t('charts.leads')]}
              colors={['amber']}
              showLegend={false}
              allowDecimals={false}
              className="h-[240px]"
            />
          )}
        </Card>

        {/* Team */}
        <Card title={t('team.title')} hint={t('team.hint', { target })}>
          {loading ? (
            <div className="bg-muted h-[240px] animate-pulse rounded-lg" />
          ) : responders.length === 0 ? (
            <EmptyState icon={MessageCircleWarning} title={t('empty')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-left text-xs">
                  <tr>
                    <th className="py-2 pr-3 font-medium">{t('team.who')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('team.replies')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('team.median')}</th>
                    <th className="py-2 text-right font-medium">{t('team.within')}</th>
                  </tr>
                </thead>
                <tbody>
                  {responders.map((r) => (
                    <tr key={r.key} className="border-border border-t">
                      <td className="py-2 pr-3">
                        {r.kind === 'ai' ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Bot className="size-3.5" /> {t('kind.aiAgents')}
                          </span>
                        ) : (
                          people.get(r.key) ?? t('team.unknown')
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.replies}</td>
                      <td
                        className={cn(
                          'py-2 pr-3 text-right tabular-nums',
                          (r.medianMinutes ?? 0) > target && 'text-rose-600 dark:text-rose-400'
                        )}
                      >
                        {formatDuration(r.medianMinutes)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {r.withinTargetPct === null ? '—' : `${r.withinTargetPct}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Leads */}
      <section className="border-border bg-card rounded-xl border">
        <header className="border-border flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-foreground text-sm font-semibold">{t('table.title')}</h2>
            <p className="text-muted-foreground mt-0.5 text-xs">{t('table.hint')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(['all', 'late', 'unanswered', 'ai', 'human'] as LeadFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs',
                  filter === f
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {t(`filter.${f}`)}
              </button>
            ))}
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="size-3.5" /> CSV
            </Button>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="px-5 py-2 font-medium">{t('table.contact')}</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">{t('table.number')}</th>
                <th className="px-3 py-2 font-medium">{t('table.arrived')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('table.firstReply')}</th>
                <th className="px-5 py-2 font-medium">{t('table.who')}</th>
              </tr>
            </thead>
            <tbody>
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted-foreground px-5 py-8 text-center text-sm">
                    {t('empty')}
                  </td>
                </tr>
              )}
              {filtered.slice(0, 500).map((l) => {
                const m = firstReplyMinutes(l);
                return (
                  <tr key={l.conversation_id} className="border-border hover:bg-muted/40 border-t">
                    <td className="px-5 py-2">
                      <Link href={`/inbox?c=${l.conversation_id}`} className="hover:underline">
                        <span className="text-foreground font-medium">
                          {l.contact_name || l.contact_phone || '—'}
                        </span>
                      </Link>
                      {l.contact_name && l.contact_phone && (
                        <span className="text-muted-foreground block text-xs">{l.contact_phone}</span>
                      )}
                    </td>
                    <td className="text-muted-foreground hidden px-3 py-2 text-xs md:table-cell">
                      {numberLabel(l)}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap tabular-nums">
                      {new Date(l.arrived_at).toLocaleString(APP_LOCALE, {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 text-right text-xs whitespace-nowrap tabular-nums',
                        m === null
                          ? 'text-amber-700 dark:text-amber-300'
                          : m > target
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-emerald-700 dark:text-emerald-300'
                      )}
                    >
                      {m === null ? t('kind.none') : formatDuration(m)}
                    </td>
                    <td className="px-5 py-2 text-xs">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5',
                          l.first_reply_kind === 'ai'
                            ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
                            : l.first_reply_kind === 'human'
                              ? 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300'
                              : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {whoLabel(l)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length > 500 && (
            <p className="text-muted-foreground px-5 py-3 text-xs">
              {t('table.truncated', { count: filtered.length })}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-card rounded-xl border">
      <header className="border-border border-b px-5 py-4">
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        {hint && <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
