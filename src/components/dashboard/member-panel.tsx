'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { CalendarCheck, ChevronLeft, ChevronRight, Circle, MessageSquare, Moon, StickyNote, Trophy, X, XCircle, ArrowRight, Plus } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { SidePanel } from '@/components/ui/side-panel';
import { cn } from '@/lib/utils';
import { startOfToday } from '@/lib/dashboard/manager';
import {
  GOAL_METRICS,
  cleanTimeline,
  findGoal,
  formatMinutes,
  metricValue,
  monthPace,
  progressPct,
  startOfMonth,
  type GoalRow,
  type PerfLike,
  type TimelineRow,
} from '@/lib/dashboard/goals';

/**
 * One person, opened from the Equipe tab (migration 136): goals for today
 * and the month, time online, and their day as a timeline — when they
 * came online, how many replies per hour, deals and appointments.
 */
export function MemberPanel({
  member,
  goals,
  onClose,
}: {
  member: { userId: string; name: string } | null;
  goals: GoalRow[];
  onClose: () => void;
}) {
  const t = useTranslations('Manager.member');
  return (
    <SidePanel open={!!member} onClose={onClose} label={t('title')}>
      {member && <MemberBody key={member.userId} member={member} goals={goals} onClose={onClose} />}
    </SidePanel>
  );
}

const ICONS: Record<string, typeof Circle> = {
  online: Circle,
  away: Moon,
  replies: MessageSquare,
  deal_won: Trophy,
  deal_lost: XCircle,
  deal_stage: ArrowRight,
  deal_created: Plus,
  deal_open: ArrowRight,
  appointment: CalendarCheck,
  note: StickyNote,
};

function MemberBody({
  member,
  goals,
  onClose,
}: {
  member: { userId: string; name: string };
  goals: GoalRow[];
  onClose: () => void;
}) {
  const t = useTranslations('Manager.member');
  const tg = useTranslations('Manager.goals');
  const { accountId, defaultCurrency } = useAuth();
  const [dayOffset, setDayOffset] = useState(0);
  const [timeline, setTimeline] = useState<TimelineRow[] | null>(null);
  const [today, setToday] = useState<PerfLike | undefined>();
  const [month, setMonth] = useState<PerfLike | undefined>();
  const [online, setOnline] = useState<{ online_minutes: number | null; first_seen: string | null; last_seen: string | null } | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const db = createClient();
    const now = new Date();
    const dayStart = new Date(startOfToday(now).getTime() + dayOffset * 86_400_000);
    const dayEnd = dayOffset === 0 ? now : new Date(dayStart.getTime() + 86_400_000);
    const pick = (rows: unknown) => ((rows as (PerfLike & { user_id: string })[]) ?? []).find((r) => r.user_id === member.userId);
    void Promise.all([
      db.rpc('member_timeline', { p_account_id: accountId, p_user_id: member.userId, p_from: dayStart.toISOString(), p_to: dayEnd.toISOString() }),
      db.rpc('team_performance', { p_account_id: accountId, p_from: dayStart.toISOString(), p_to: dayEnd.toISOString() }),
      db.rpc('team_performance', { p_account_id: accountId, p_from: startOfMonth(now).toISOString(), p_to: now.toISOString() }),
      db.rpc('team_presence_minutes', { p_account_id: accountId, p_from: dayStart.toISOString(), p_to: dayEnd.toISOString() }),
    ]).then(([tl, day, mon, pres]) => {
      if (cancelled) return;
      if (tl.error) console.error('[member panel] timeline failed:', tl.error);
      setTimeline(cleanTimeline((tl.data as TimelineRow[]) ?? []));
      setToday(pick(day.data));
      setMonth(pick(mon.data));
      setOnline(((pres.data as { user_id: string; online_minutes: number; first_seen: string; last_seen: string }[]) ?? []).find((r) => r.user_id === member.userId) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, member.userId, dayOffset]);

  const pace = monthPace(new Date());
  const shownGoals = GOAL_METRICS.flatMap((metric) =>
    (['day', 'month'] as const).map((period) => ({ metric, period, target: findGoal(goals, member.userId, metric, period) }))
  ).filter((g) => g.target !== null);
  const fmt = (metric: string, v: number) => (metric === 'won_value' ? formatCurrency(v, defaultCurrency) : String(v));
  const dayLabel = dayOffset === 0 ? t('today') : format(new Date(Date.now() + dayOffset * 86_400_000), "EEE, d 'de' MMM", { locale: dateFnsLocale });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 px-5 pt-4 pb-2">
        <h2 className="flex-1 truncate text-lg font-extrabold">{member.name}</h2>
        <button type="button" onClick={onClose} aria-label={t('close')} className="hover:bg-muted flex size-9 items-center justify-center rounded-full">
          <X className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-4 px-5 pb-6">
        {/* Goals */}
        <section className="bg-muted/60 flex flex-col gap-3 rounded-[20px] p-4">
          <span className="text-muted-foreground text-xs font-bold">{tg('title')}</span>
          {shownGoals.length === 0 ? (
            <p className="text-muted-foreground text-sm">{tg('none')}</p>
          ) : (
            shownGoals.map((g) => {
              const actual = metricValue(g.period === 'day' ? today : month, g.metric);
              const pct = progressPct(actual, g.target) ?? 0;
              const behind = g.period === 'month' && pct < pace;
              return (
                <div key={`${g.metric}:${g.period}`} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-semibold">
                      {tg(`metric.${g.metric}`)} · {tg(`period.${g.period}`)}
                    </span>
                    <span className="tabular-nums">
                      <b>{fmt(g.metric, actual)}</b> <span className="text-muted-foreground">/ {fmt(g.metric, g.target!)}</span>
                    </span>
                  </div>
                  <div className="bg-card h-2 overflow-hidden rounded-full">
                    <div
                      className={cn('h-full rounded-full', pct >= 100 ? 'bg-tone-mint-ink' : behind ? 'bg-tone-salmon-ink' : 'bg-foreground')}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
                  {g.period === 'month' && (
                    <span className={cn('text-[12px]', behind ? 'text-tone-salmon-ink' : 'text-muted-foreground')}>
                      {tg('pace', { pct, pace })}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </section>

        {/* Day picker + online time */}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setDayOffset((d) => d - 1)} aria-label={t('prevDay')} className="hover:bg-muted flex size-9 items-center justify-center rounded-full border">
            <ChevronLeft className="size-4" />
          </button>
          <span className="flex-1 text-center text-sm font-bold capitalize">{dayLabel}</span>
          <button type="button" disabled={dayOffset === 0} onClick={() => setDayOffset((d) => Math.min(0, d + 1))} aria-label={t('nextDay')} className="hover:bg-muted flex size-9 items-center justify-center rounded-full border disabled:opacity-40">
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label={t('online')} value={formatMinutes(online?.online_minutes)} />
          <Stat label={t('firstSeen')} value={online?.first_seen ? format(new Date(online.first_seen), 'HH:mm') : '—'} />
          <Stat label={t('lastSeen')} value={online?.last_seen ? format(new Date(online.last_seen), 'HH:mm') : '—'} />
        </div>

        {/* Timeline */}
        <section className="flex flex-col">
          <span className="text-muted-foreground mb-2 text-xs font-bold">{t('timeline')}</span>
          {!timeline ? (
            <div className="bg-muted h-40 animate-pulse rounded-[18px]" />
          ) : timeline.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('empty')}</p>
          ) : (
            <ol className="border-border ml-2 border-l">
              {timeline.map((r, i) => {
                const Icon = ICONS[r.kind] ?? Circle;
                const text = describe(r);
                const href = r.kind === 'note' && r.ref_id ? `/inbox?c=${r.ref_id}` : r.kind === 'appointment' ? '/agenda' : null;
                return (
                  <li key={`${r.kind}:${r.at}:${i}`} className="relative flex gap-3 py-2 pl-4">
                    <span className={cn('bg-card absolute -left-[9px] top-2.5 flex size-[18px] items-center justify-center rounded-full border', tone(r.kind))}>
                      <Icon className="size-2.5" />
                    </span>
                    <span className="text-muted-foreground w-11 shrink-0 text-[12px] tabular-nums">{format(new Date(r.at), 'HH:mm')}</span>
                    <span className="min-w-0 flex-1 text-[13px]">
                      {href ? <Link href={href} className="hover:underline">{text}</Link> : text}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </div>
  );

  function describe(r: TimelineRow): string {
    const end = r.ended_at ? format(new Date(r.ended_at), 'HH:mm') : '';
    const mins = r.ended_at ? (Date.parse(r.ended_at) - Date.parse(r.at)) / 60_000 : 0;
    switch (r.kind) {
      case 'online':
        return t('kind.online', { end, dur: formatMinutes(mins), active: formatMinutes(Number(r.amount)) });
      case 'away':
        return t('kind.away', { end, dur: formatMinutes(mins) });
      case 'replies':
        return t('kind.replies', { n: Number(r.amount) });
      case 'deal_won':
        return t('kind.dealWon', { title: r.label ?? '', value: formatCurrency(Number(r.amount ?? 0), defaultCurrency) });
      case 'deal_lost':
        return t('kind.dealLost', { title: r.label ?? '' });
      case 'deal_created':
        return t('kind.dealCreated', { title: r.label ?? '' });
      case 'appointment':
        return t('kind.appointment', { title: r.label ?? '', when: r.ended_at ? format(new Date(r.ended_at), 'dd/MM HH:mm') : '' });
      case 'note':
        return t('kind.note', { text: r.label ?? '' });
      default:
        return t('kind.dealMoved', { title: r.label ?? '' });
    }
  }
}

function tone(kind: string): string {
  if (kind === 'online') return 'text-tone-mint-ink border-tone-mint-ink';
  if (kind === 'deal_won') return 'text-tone-mint-ink border-tone-mint-ink';
  if (kind === 'deal_lost') return 'text-tone-pink-ink border-tone-pink-ink';
  if (kind === 'note') return 'text-amber-600 border-amber-500';
  return 'text-muted-foreground border-border';
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border rounded-[16px] border px-2 py-2.5">
      <div className="text-lg font-extrabold tabular-nums">{value}</div>
      <div className="text-muted-foreground text-[11.5px]">{label}</div>
    </div>
  );
}
