'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/currency';
import { formatDuration, perResponder, type ResponseRow } from '@/lib/analytics/service';
import {
  changePct,
  liveTeam,
  minutesSince,
  startOfToday,
  type AttentionRow,
  type LiveMemberView,
  type TeamLiveRow,
  type TeamPerformanceRow,
} from '@/lib/dashboard/manager';

interface TodayAppt {
  id: string;
  starts_at: string;
  title: string;
  assigned_to: string | null;
  source: string;
  contact: { name: string | null; phone: string | null } | null;
}

interface Data {
  team: LiveMemberView[];
  ai: { replies: number; median: number | null };
  attention: AttentionRow[];
  names: Map<string, string>;
  conversationsToday: number;
  conversationsLastWeek: number;
  waitingNow: number;
  wonToday: number;
  dealsWonToday: number;
  appts: TodayAppt[];
}

/**
 * "Visão geral" for the account owner / admins (specs/painel-gestor.md):
 * what is happening now — who waits, how each person is doing today, and
 * what needs a person. Every row links to where it is acted on.
 */
export function ManagerOverview() {
  const t = useTranslations('Manager');
  const { accountId, responseTimeTargetMinutes, defaultCurrency } = useAuth();
  const target = responseTimeTargetMinutes || 10;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    setError(false);
    try {
      const db = createClient();
      const now = new Date();
      const today = startOfToday(now);
      const lastWeekFrom = new Date(today.getTime() - 7 * 86_400_000);
      const lastWeekTo = new Date(now.getTime() - 7 * 86_400_000);
      const dayEnd = new Date(today.getTime() + 86_400_000);
      const range = (from: Date, to: Date) => ({
        p_account_id: accountId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });

      const [live, attention, responses, lastWeek, perf, appts] = await Promise.all([
        db.rpc('team_live', { p_account_id: accountId, p_since: today.toISOString() }),
        db.rpc('attention_items', { p_account_id: accountId, p_target_minutes: target }),
        fetchAllRows<ResponseRow>((f, to) => db.rpc('service_responses', range(today, now)).range(f, to)),
        fetchAllRows<ResponseRow>((f, to) => db.rpc('service_responses', range(lastWeekFrom, lastWeekTo)).range(f, to)),
        db.rpc('team_performance', range(today, now)),
        db
          .from('appointments')
          .select('id, starts_at, title, assigned_to, source, contact:contacts(name, phone)')
          .gte('starts_at', now.toISOString())
          .lt('starts_at', dayEnd.toISOString())
          .neq('status', 'cancelled')
          .order('starts_at')
          .limit(8),
      ]);
      if (live.error || attention.error || perf.error) throw live.error ?? attention.error ?? perf.error;

      const liveRows = (live.data ?? []) as TeamLiveRow[];
      const att = (attention.data ?? []) as AttentionRow[];
      const aiStats = perResponder(responses, target).find((s) => s.key === 'ai');
      const perfRows = (perf.data ?? []) as TeamPerformanceRow[];
      setData({
        team: liveTeam(liveRows, responses, target, now),
        ai: { replies: aiStats?.replies ?? 0, median: aiStats?.medianMinutes ?? null },
        attention: att,
        names: new Map(liveRows.map((m) => [m.user_id, m.full_name?.trim() || '—'])),
        conversationsToday: new Set(responses.map((r) => r.conversation_id)).size,
        conversationsLastWeek: new Set(lastWeek.map((r) => r.conversation_id)).size,
        waitingNow:
          liveRows.reduce((n, m) => n + Number(m.waiting_count), 0) +
          att.filter((a) => a.reason === 'unassigned').length,
        wonToday: perfRows.reduce((n, p) => n + Number(p.won_value), 0),
        dealsWonToday: perfRows.reduce((n, p) => n + Number(p.deals_won), 0),
        appts: ((appts.data ?? []) as unknown as TodayAppt[]),
      });
    } catch (err) {
      console.error('[manager overview] load failed:', err);
      setError(true);
    }
  }, [accountId, target]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (error) {
    return (
      <div className="border-border bg-card flex items-center justify-between gap-3 rounded-[22px] border p-5 text-sm">
        <span>{t('loadError')}</span>
        <button type="button" onClick={() => void load()} className="border-border hover:bg-muted inline-flex min-h-10 items-center gap-2 rounded-full border px-4 font-semibold">
          <RefreshCw className="size-4" /> {t('retry')}
        </button>
      </div>
    );
  }
  if (!data) return <div className="bg-muted h-64 animate-pulse rounded-[22px]" />;

  const change = changePct(data.conversationsToday, data.conversationsLastWeek);
  const now = new Date();
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi tone={data.waitingNow > 0 ? 'warn' : 'plain'} label={t('kpi.waiting')} value={String(data.waitingNow)} hint={data.waitingNow > 0 ? t('kpi.waitingHint') : t('kpi.nobodyWaiting')} />
        <Kpi
          label={t('kpi.conversations')}
          value={String(data.conversationsToday)}
          hint={change === null ? t('kpi.noCompare') : t('kpi.vsLastWeek', { pct: `${change > 0 ? '+' : ''}${change}%` })}
          hintTone={change !== null && change >= 0 ? 'good' : undefined}
        />
        <Kpi label={t('kpi.aiReplies')} value={String(data.ai.replies)} hint={t('kpi.aiSpeed', { time: formatDuration(data.ai.median) })} />
        <Kpi label={t('kpi.won')} value={formatCurrency(data.wonToday, defaultCurrency)} hint={t('kpi.wonHint', { deals: data.dealsWonToday, appts: data.appts.length })} />
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <section aria-labelledby="mgr-team" className="border-border bg-card flex min-w-0 flex-[999_1_560px] flex-col gap-3 rounded-[24px] border p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="mgr-team" className="text-lg font-extrabold">{t('teamNow')}</h2>
            <Link href="/dashboard?tab=team" className="text-primary text-[13px] font-bold">{t('seeTeam')}</Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="text-muted-foreground text-left text-xs">
                  <th className="px-1.5 py-2 font-bold">{t('col.member')}</th>
                  <th className="px-1.5 py-2 font-bold">{t('col.status')}</th>
                  <th className="px-1.5 py-2 text-right font-bold">{t('col.open')}</th>
                  <th className="px-1.5 py-2 text-right font-bold">{t('col.waiting')}</th>
                  <th className="px-1.5 py-2 text-right font-bold">{t('col.speedToday')}</th>
                  <th className="px-1.5 py-2 text-right font-bold">{t('col.repliesToday')}</th>
                </tr>
              </thead>
              <tbody>
                {data.team.map((m) => (
                  <tr key={m.userId} className="border-border border-t">
                    <td className="px-1.5 py-3 font-bold">{m.name}</td>
                    <td className="px-1.5 py-3"><PresencePill presence={m.presence} t={t} /></td>
                    <td className="px-1.5 py-3 text-right tabular-nums">{m.open}</td>
                    <td className={cn('px-1.5 py-3 text-right tabular-nums', m.waiting > 0 && m.late && 'text-tone-salmon-ink font-extrabold')}>
                      {m.waiting}
                      {m.oldestWaitMinutes !== null && <span className="text-muted-foreground ml-1 text-xs font-normal">({formatDuration(m.oldestWaitMinutes)})</span>}
                    </td>
                    <td className={cn('px-1.5 py-3 text-right tabular-nums', m.medianMinutesToday !== null && m.medianMinutesToday > target && 'text-tone-salmon-ink font-extrabold')}>
                      {formatDuration(m.medianMinutesToday)}
                    </td>
                    <td className="px-1.5 py-3 text-right tabular-nums">{m.repliesToday}</td>
                  </tr>
                ))}
                <tr className="border-border border-t">
                  <td className="px-1.5 py-3 font-bold">{t('aiAgents')}</td>
                  <td className="px-1.5 py-3"><span className="bg-tone-mint-soft text-tone-mint-ink rounded-full px-2.5 py-1 text-xs font-bold">{t('presence.active')}</span></td>
                  <td className="px-1.5 py-3 text-right">—</td>
                  <td className="px-1.5 py-3 text-right">—</td>
                  <td className="px-1.5 py-3 text-right tabular-nums">{formatDuration(data.ai.median)}</td>
                  <td className="px-1.5 py-3 text-right tabular-nums">{data.ai.replies}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground text-[13px]">{t('lateNote', { min: target })}</p>
        </section>

        <section aria-labelledby="mgr-att" className="border-border bg-card flex min-w-0 flex-[1_1_320px] flex-col gap-2.5 rounded-[24px] border p-5">
          <h2 id="mgr-att" className="text-lg font-extrabold">{t('attention')}</h2>
          {data.attention.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('attentionEmpty')}</p>
          ) : (
            data.attention.slice(0, 8).map((a) => {
              const wait = formatDuration(minutesSince(a.waiting_since, now));
              const who = a.contact_name || a.contact_phone || '—';
              const line =
                a.reason === 'unassigned'
                  ? t('reason.unassigned', { wait })
                  : a.reason === 'ai_handoff'
                    ? t('reason.aiHandoff', { wait })
                    : t('reason.late', { name: data.names.get(a.assigned_agent_id ?? '') ?? '—', wait });
              return (
                <Link
                  key={a.conversation_id}
                  href={`/inbox?c=${a.conversation_id}`}
                  className={cn(
                    'flex items-center gap-3 rounded-[16px] px-3.5 py-2.5',
                    a.reason === 'ai_handoff' ? 'bg-tone-lilac-soft' : 'bg-tone-salmon-soft'
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <strong className="truncate text-sm">{who}</strong>
                    <span className={cn('text-[12.5px]', a.reason === 'ai_handoff' ? 'text-tone-lilac-ink' : 'text-tone-salmon-ink')}>{line}</span>
                  </span>
                  <span className="text-xs font-extrabold">{t('open')}</span>
                </Link>
              );
            })
          )}
        </section>
      </div>

      <section aria-labelledby="mgr-agenda" className="border-border bg-card flex flex-col gap-2 rounded-[24px] border p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 id="mgr-agenda" className="text-lg font-extrabold">{t('agendaToday')}</h2>
          <Link href="/agenda" className="text-primary text-[13px] font-bold">{t('openAgenda')}</Link>
        </div>
        {data.appts.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('agendaEmpty')}</p>
        ) : (
          data.appts.map((a) => (
            <div key={a.id} className="flex items-center gap-3 text-sm">
              <strong className="w-12 tabular-nums">{time(a.starts_at)}</strong>
              <span className="min-w-0 flex-1 truncate">{a.contact?.name || a.contact?.phone || a.title}</span>
              <span className="text-muted-foreground text-xs">
                {a.assigned_to ? data.names.get(a.assigned_to) ?? '—' : a.source === 'ai' ? t('bookedByAi') : ''}
              </span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone = 'plain',
  hintTone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'plain' | 'warn';
  hintTone?: 'good';
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-[20px] p-4',
        tone === 'warn' ? 'bg-tone-salmon-soft' : 'border-border bg-card border'
      )}
    >
      <span className={cn('text-[13px] font-bold', tone === 'warn' ? 'text-tone-salmon-ink' : 'text-muted-foreground')}>{label}</span>
      <strong className="text-[28px] leading-tight font-extrabold tracking-[-0.02em] tabular-nums">{value}</strong>
      <span className={cn('text-[12.5px]', tone === 'warn' ? 'text-tone-salmon-ink' : hintTone === 'good' ? 'text-tone-mint-ink' : 'text-muted-foreground')}>{hint}</span>
    </div>
  );
}

function PresencePill({ presence, t }: { presence: string; t: ReturnType<typeof useTranslations> }) {
  const cls =
    presence === 'online'
      ? 'bg-tone-mint-soft text-tone-mint-ink'
      : presence === 'away'
        ? 'bg-tone-salmon-soft text-tone-salmon-ink'
        : 'bg-muted text-muted-foreground';
  return <span className={cn('rounded-full px-2.5 py-1 text-xs font-bold', cls)}>{t(`presence.${presence}`)}</span>;
}
