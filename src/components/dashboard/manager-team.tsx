'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Target } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/currency';
import { formatDuration, type ResponseRow } from '@/lib/analytics/service';
import {
  startOfToday,
  teamPerformance,
  type PerformanceView,
  type TeamLiveRow,
  type TeamPerformanceRow,
} from '@/lib/dashboard/manager';
import { ManagerOrigins } from './manager-origins';
import { MemberPanel } from './member-panel';
import { GoalsEditor } from './goals-editor';
import {
  GOAL_METRICS,
  findGoal,
  formatMinutes,
  metricValue,
  monthPace,
  progressPct,
  startOfMonth,
  type GoalRow,
  type PerfLike,
} from '@/lib/dashboard/goals';

const PERIODS = [1, 7, 30] as const;
type Period = (typeof PERIODS)[number];

/**
 * "Equipe": what each person did in a period — conversations, replies,
 * typical first-reply time against the target, who still owes replies
 * now, deals won and appointments (specs/painel-gestor.md).
 */
export function ManagerTeam() {
  const t = useTranslations('Manager');
  const { accountId, responseTimeTargetMinutes, defaultCurrency } = useAuth();
  const target = responseTimeTargetMinutes || 10;
  const [period, setPeriod] = useState<Period>(7);
  const [rows, setRows] = useState<PerformanceView[] | null>(null);
  const [error, setError] = useState(false);
  // Phase 4 (migration 136): goals, time online, one person's day.
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [online, setOnline] = useState<Map<string, number>>(new Map());
  const [monthTotals, setMonthTotals] = useState<PerfLike | undefined>();
  const [openMember, setOpenMember] = useState<{ userId: string; name: string } | null>(null);
  const [editingGoals, setEditingGoals] = useState(false);
  // Fixed per period choice so the origin report doesn't refetch every render.
  const range = useMemo(() => {
    const now = new Date();
    return { from: period === 1 ? startOfToday(now) : new Date(now.getTime() - period * 86_400_000), to: now };
  }, [period]);

  const load = useCallback(async () => {
    if (!accountId) return;
    setError(false);
    try {
      const db = createClient();
      const now = new Date();
      const from = period === 1 ? startOfToday(now) : new Date(now.getTime() - period * 86_400_000);
      const args = { p_account_id: accountId, p_from: from.toISOString(), p_to: now.toISOString() };
      const [perf, live, responses, goalRows, presence, month] = await Promise.all([
        db.rpc('team_performance', args),
        db.rpc('team_live', { p_account_id: accountId, p_since: startOfToday(now).toISOString() }),
        fetchAllRows<ResponseRow>((f, to) => db.rpc('service_responses', args).range(f, to)),
        db.from('team_goals').select('id, user_id, metric, period, target'),
        db.rpc('team_presence_minutes', args),
        db.rpc('team_performance', { p_account_id: accountId, p_from: startOfMonth(now).toISOString(), p_to: now.toISOString() }),
      ]);
      if (perf.error || live.error) throw perf.error ?? live.error;
      setGoals((goalRows.data as GoalRow[]) ?? []);
      setOnline(
        new Map(((presence.data as { user_id: string; online_minutes: number | null }[]) ?? []).map((r) => [r.user_id, Number(r.online_minutes) || 0]))
      );
      // Team month totals, for the whole-team goals strip.
      const sum = (k: keyof PerfLike) => ((month.data as PerfLike[]) ?? []).reduce((s, r) => s + (Number(r[k]) || 0), 0);
      setMonthTotals({ conversations: sum('conversations'), deals_won: sum('deals_won'), won_value: sum('won_value'), appointments: sum('appointments') });
      setRows(
        teamPerformance(
          (perf.data ?? []) as TeamPerformanceRow[],
          (live.data ?? []) as TeamLiveRow[],
          responses,
          target
        )
      );
    } catch (err) {
      console.error('[manager team] load failed:', err);
      setError(true);
    }
  }, [accountId, period, target]);

  useEffect(() => {
    void load();
  }, [load]);

  function exportCsv() {
    if (!rows) return;
    const head = [t('col.member'), t('col.conversations'), t('col.replies'), t('col.typical'), t('col.withinTarget'), t('col.waitingNow'), t('col.dealsWon'), t('col.wonValue'), t('col.appointments')];
    const lines = rows.map((r) =>
      [r.name, r.conversations, r.replies, r.medianMinutes === null ? '' : Math.round(r.medianMinutes), r.withinTargetPct ?? '', r.waitingNow, r.dealsWon, r.wonValue.toFixed(2), r.appointments]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `equipe-${period}d.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const pace = monthPace(new Date());
  const teamGoals = GOAL_METRICS.map((m) => ({ metric: m, target: findGoal(goals, null, m, 'month') })).filter((g) => g.target !== null);
  const members = (rows ?? []).map((r) => ({ userId: r.userId, name: r.name }));

  return (
    <div className="flex flex-col gap-4">
    {teamGoals.length > 0 && (
      <section aria-label={t('goals.teamMonth')} className="border-border bg-card grid gap-3 rounded-[24px] border p-5 sm:grid-cols-2 lg:grid-cols-4">
        {teamGoals.map((g) => {
          const actual = metricValue(monthTotals, g.metric);
          const pct = progressPct(actual, g.target) ?? 0;
          return (
            <div key={g.metric} className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs font-bold">{t('goals.teamMonth')} · {t(`goals.metric.${g.metric}`)}</span>
              <span className="text-xl font-extrabold tabular-nums">
                {g.metric === 'won_value' ? formatCurrency(actual, defaultCurrency) : actual}
                <span className="text-muted-foreground text-sm font-semibold"> / {g.metric === 'won_value' ? formatCurrency(g.target!, defaultCurrency) : g.target}</span>
              </span>
              <div className="bg-muted h-2 overflow-hidden rounded-full">
                <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-tone-mint-ink' : pct < pace ? 'bg-tone-salmon-ink' : 'bg-foreground')} style={{ width: `${Math.min(pct, 100)}%` }} />
              </div>
              <span className={cn('text-[12px]', pct < pace ? 'text-tone-salmon-ink' : 'text-muted-foreground')}>{t('goals.pace', { pct, pace })}</span>
            </div>
          );
        })}
      </section>
    )}
    <section aria-labelledby="mgr-perf" className="border-border bg-card flex flex-col gap-3 rounded-[24px] border p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="mgr-perf" className="text-lg font-extrabold">{t('whoDidWhat')}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              onClick={() => setPeriod(p)}
              className={cn(
                'min-h-9 rounded-full border px-3.5 text-[13px] font-semibold',
                period === p ? 'bg-foreground text-background border-transparent' : 'border-border hover:bg-muted'
              )}
            >
              {t(`period.${p}`)}
            </button>
          ))}
          <button type="button" onClick={() => setEditingGoals(true)} className="border-border hover:bg-muted inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold">
            <Target className="size-3.5" /> {t('goals.edit')}
          </button>
          <button type="button" onClick={exportCsv} disabled={!rows?.length} className="border-border hover:bg-muted inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold disabled:opacity-50">
            <Download className="size-3.5" /> CSV
          </button>
        </div>
      </div>

      {error ? (
        <p className="text-sm">{t('loadError')}</p>
      ) : !rows ? (
        <div className="bg-muted h-48 animate-pulse rounded-[18px]" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="text-muted-foreground text-left text-xs">
                <th className="px-1.5 py-2 font-bold">{t('col.member')}</th>
                <th className="px-1.5 py-2 text-right font-bold">{t('col.online')}</th>
                <th className="px-1.5 py-2 text-right font-bold">{t('col.conversations')}</th>
                <th className="px-1.5 py-2 text-right font-bold">{t('col.typical')}</th>
                <th className="px-1.5 py-2 text-right font-bold">{t('col.withinTarget')}</th>
                <th className="px-1.5 py-2 text-right font-bold">{t('col.waitingNow')}</th>
                <th className="px-1.5 py-2 text-right font-bold">{t('col.dealsWon')}</th>
                <th className="px-1.5 py-2 text-right font-bold">{t('col.wonValue')}</th>
                <th className="px-1.5 py-2 text-right font-bold">{t('col.appointments')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const slow = r.medianMinutes !== null && r.medianMinutes > target;
                return (
                  <tr key={r.userId} className="border-border border-t">
                    <td className="px-1.5 py-3 font-bold">
                      <button type="button" onClick={() => setOpenMember({ userId: r.userId, name: r.name })} className="text-left hover:underline">
                        {r.name}
                      </button>
                    </td>
                    <td className="px-1.5 py-3 text-right tabular-nums">{formatMinutes(online.get(r.userId))}</td>
                    <td className="px-1.5 py-3 text-right tabular-nums">{r.conversations}</td>
                    <td className={cn('px-1.5 py-3 text-right tabular-nums', slow && 'text-tone-salmon-ink font-extrabold')}>{formatDuration(r.medianMinutes)}</td>
                    <td className="px-1.5 py-3 text-right">
                      {r.withinTargetPct === null ? '—' : (
                        <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', r.withinTargetPct >= 70 ? 'bg-tone-mint-soft text-tone-mint-ink' : 'bg-tone-salmon-soft text-tone-salmon-ink')}>
                          {r.withinTargetPct}%
                        </span>
                      )}
                    </td>
                    <td className={cn('px-1.5 py-3 text-right tabular-nums', r.waitingNow > 0 && 'text-tone-salmon-ink font-extrabold')}>{r.waitingNow}</td>
                    <td className="px-1.5 py-3 text-right tabular-nums">{r.dealsWon}</td>
                    <td className="px-1.5 py-3 text-right tabular-nums">{formatCurrency(r.wonValue, defaultCurrency)}</td>
                    <td className="px-1.5 py-3 text-right tabular-nums">{r.appointments}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-muted-foreground text-[13px]">{t('teamNote', { min: target })} {t('memberHint')}</p>
    </section>
    <ManagerOrigins from={range.from} to={range.to} />
    <MemberPanel member={openMember} goals={goals} onClose={() => setOpenMember(null)} />
    <GoalsEditor open={editingGoals} members={members} goals={goals} onClose={() => setEditingGoals(false)} onSaved={() => void load()} />
    </div>
  );
}
