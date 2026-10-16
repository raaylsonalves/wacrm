'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { ArrowLeft, CalendarCheck, Maximize, Sparkles, Trophy, UserPlus } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useSegment } from '@/hooks/use-segment';
import { formatCurrency } from '@/lib/currency';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { cn } from '@/lib/utils';
import { formatDuration, perResponder, type ResponseRow } from '@/lib/analytics/service';
import { liveTeam, startOfToday, type LiveMemberView, type TeamLiveRow, type TeamPerformanceRow } from '@/lib/dashboard/manager';
import { GOAL_METRICS, findGoal, formatMinutes, metricValue, monthPace, progressPct, startOfMonth, type GoalRow, type PerfLike } from '@/lib/dashboard/goals';
import { buildFeed, rankTeam, type FeedItem, type RankInput } from '@/lib/dashboard/hub';

const REFRESH_MS = 30_000;

interface HubData {
  team: LiveMemberView[];
  online: Map<string, number>;
  waiting: number;
  conversations: number;
  ai: { replies: number; median: number | null };
  wonToday: number;
  apptsToday: number;
  ranking: RankInput[];
  goals: { metric: (typeof GOAL_METRICS)[number]; target: number; actual: number }[];
  feed: FeedItem[];
}

/**
 * Live hub for a TV on the wall (specs/painel-gestor.md phase 5): who is
 * working, who waits, the day's ranking, the month's goals and what just
 * happened. Full screen (dashboard-shell renders /hub bare), refreshes
 * every 30s, and sends no presence heartbeat.
 */
export default function HubPage() {
  const t = useTranslations('Hub');
  const tg = useTranslations('Manager.goals');
  const canView = useCan('view-team');
  const { accountId, account, responseTimeTargetMinutes, defaultCurrency } = useAuth();
  const { profile } = useSegment();
  const target = responseTimeTargetMinutes || 10;
  const [data, setData] = useState<HubData | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    if (!accountId) return;
    const db = createClient();
    const at = new Date();
    const today = startOfToday(at);
    const range = (from: Date) => ({ p_account_id: accountId, p_from: from.toISOString(), p_to: at.toISOString() });
    try {
      const [live, attention, responses, perf, month, goalRows, presence, won, appts, leads] = await Promise.all([
        db.rpc('team_live', { p_account_id: accountId, p_since: today.toISOString() }),
        db.rpc('attention_items', { p_account_id: accountId, p_target_minutes: target }),
        fetchAllRows<ResponseRow>((f, to) => db.rpc('service_responses', range(today)).range(f, to)),
        db.rpc('team_performance', range(today)),
        db.rpc('team_performance', range(startOfMonth(at))),
        db.from('team_goals').select('user_id, metric, period, target').is('user_id', null).eq('period', 'month'),
        db.rpc('team_presence_minutes', range(today)),
        db
          .from('deal_events')
          .select('created_at, actor_user_id, deal:deals(title, value)')
          .eq('kind', 'status')
          .eq('to_value', '"won"')
          .gte('created_at', today.toISOString())
          .order('created_at', { ascending: false })
          .limit(10),
        db
          .from('appointments')
          .select('created_at, title, assigned_to, starts_at')
          .gte('created_at', today.toISOString())
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false })
          .limit(10),
        db
          .from('contacts')
          .select('created_at, name, lead_source, lead_source_detail')
          .gte('created_at', today.toISOString())
          .order('created_at', { ascending: false })
          .limit(10),
      ]);
      if (live.error || perf.error) throw live.error ?? perf.error;

      const liveRows = (live.data ?? []) as TeamLiveRow[];
      const names = new Map(liveRows.map((m) => [m.user_id, m.full_name?.trim() || '—']));
      const perfRows = (perf.data ?? []) as TeamPerformanceRow[];
      const att = (attention.data ?? []) as { reason: string }[];
      const aiStats = perResponder(responses, target).find((s) => s.key === 'ai');
      const monthRows = (month.data ?? []) as PerfLike[];
      const sum = (k: keyof PerfLike) => monthRows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
      const totals: PerfLike = { conversations: sum('conversations'), deals_won: sum('deals_won'), won_value: sum('won_value'), appointments: sum('appointments') };
      const goals = (goalRows.data as GoalRow[]) ?? [];

      setData({
        team: liveTeam(liveRows, responses, target, at),
        online: new Map(((presence.data as { user_id: string; online_minutes: number }[]) ?? []).map((r) => [r.user_id, Number(r.online_minutes) || 0])),
        waiting: liveRows.reduce((n, m) => n + Number(m.waiting_count), 0) + att.filter((a) => a.reason === 'unassigned').length,
        conversations: new Set(responses.map((r) => r.conversation_id)).size,
        ai: { replies: aiStats?.replies ?? 0, median: aiStats?.medianMinutes ?? null },
        wonToday: perfRows.reduce((n, p) => n + Number(p.won_value), 0),
        apptsToday: perfRows.reduce((n, p) => n + Number(p.appointments), 0),
        ranking: rankTeam(
          perfRows.map((p) => ({
            user_id: p.user_id,
            name: names.get(p.user_id) ?? '—',
            won_value: Number(p.won_value) || 0,
            deals_won: Number(p.deals_won) || 0,
            appointments: Number(p.appointments) || 0,
            replies: Number(p.replies) || 0,
          }))
        ),
        goals: GOAL_METRICS.map((m) => ({ metric: m, target: findGoal(goals, null, m, 'month') ?? 0, actual: metricValue(totals, m) })).filter((g) => g.target > 0),
        feed: buildFeed([
          ...((won.data ?? []) as unknown as { created_at: string; actor_user_id: string | null; deal: { title: string; value: number } | null }[]).map((e) => ({
            at: e.created_at,
            kind: 'won' as const,
            who: e.actor_user_id ? names.get(e.actor_user_id) ?? null : null,
            title: e.deal?.title ?? '',
            amount: Number(e.deal?.value ?? 0),
          })),
          ...((appts.data ?? []) as { created_at: string; title: string; assigned_to: string | null }[]).map((a) => ({
            at: a.created_at,
            kind: 'appointment' as const,
            who: a.assigned_to ? names.get(a.assigned_to) ?? null : null,
            title: a.title,
          })),
          ...((leads.data ?? []) as { created_at: string; name: string | null; lead_source: string | null; lead_source_detail: Record<string, string> | null }[]).map((c) => ({
            at: c.created_at,
            kind: 'lead' as const,
            who: null,
            title: c.name || t('newContact'),
          })),
        ]),
      });
    } catch (err) {
      console.error('[hub] load failed:', err);
    }
  }, [accountId, target, t]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    const clock = setInterval(() => setNow(new Date()), 15_000);
    return () => {
      clearInterval(id);
      clearInterval(clock);
    };
  }, [load]);

  if (!canView) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-lg font-bold">{t('adminOnly')}</p>
        <Link href="/dashboard" className="text-primary font-semibold">{t('back')}</Link>
      </div>
    );
  }

  const pace = monthPace(now);
  const working = data?.team.filter((m) => m.presence !== 'offline') ?? [];
  const offline = data?.team.filter((m) => m.presence === 'offline') ?? [];

  return (
    <div className="flex h-full flex-col gap-[1.6vh] overflow-hidden p-[2vh] text-[clamp(14px,1.05vw,22px)]">
      {/* Top bar */}
      <header className="flex items-center gap-4">
        <Link href="/dashboard" aria-label={t('back')} className="hover:bg-muted flex size-10 items-center justify-center rounded-full opacity-40 hover:opacity-100">
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="text-[1.6em] font-extrabold tracking-tight">{account?.display_name || account?.name || t('title')}</h1>
        <span className="bg-tone-mint-soft text-tone-mint-ink inline-flex items-center gap-2 rounded-full px-3 py-1 text-[0.8em] font-bold">
          <span className="bg-tone-mint-ink size-2 animate-pulse rounded-full" /> {t('live')}
        </span>
        <span className="flex-1" />
        <span className="text-muted-foreground text-[0.9em] first-letter:uppercase inline-block">{format(now, "EEEE, d 'de' MMMM", { locale: dateFnsLocale })}</span>
        <span className="text-[1.8em] font-extrabold tabular-nums">{format(now, 'HH:mm')}</span>
        <button
          type="button"
          onClick={() => void document.documentElement.requestFullscreen?.().catch(() => {})}
          aria-label={t('fullscreen')}
          className="hover:bg-muted flex size-10 items-center justify-center rounded-full opacity-40 hover:opacity-100"
        >
          <Maximize className="size-5" />
        </button>
      </header>

      {!data ? (
        <div className="bg-muted flex-1 animate-pulse rounded-[28px]" />
      ) : (
        <>
          {/* KPIs */}
          <section className="grid grid-cols-2 gap-[1.6vh] lg:grid-cols-4">
            <Kpi tone={data.waiting > 0 ? 'warn' : 'ok'} label={t('waiting')} value={String(data.waiting)} hint={data.waiting > 0 ? t('waitingHint') : t('nobodyWaiting')} />
            <Kpi label={t('conversations')} value={String(data.conversations)} hint={t('today')} />
            {profile.blocks.sales ? (
              <Kpi label={t('sold')} value={formatCurrency(data.wonToday, defaultCurrency)} hint={t('today')} />
            ) : (
              <Kpi label={t('appointments')} value={String(data.apptsToday)} hint={t('today')} />
            )}
            <Kpi label={t('ai')} value={String(data.ai.replies)} hint={t('aiSpeed', { time: formatDuration(data.ai.median) })} icon={<Sparkles className="size-[1em]" />} />
          </section>

          <div className="grid min-h-0 flex-1 gap-[1.6vh] lg:grid-cols-[1.35fr_1fr_1fr]">
            {/* Team now */}
            <Panel title={t('teamNow', { n: working.length })}>
              <ul className="flex flex-col gap-[1vh]">
                {working.map((m) => (
                  <li key={m.userId} className={cn('flex items-center gap-3 rounded-[18px] px-3 py-[1vh]', m.late ? 'bg-tone-salmon-soft' : 'bg-muted/60')}>
                    <span className="bg-card relative flex size-[2.4em] shrink-0 items-center justify-center rounded-full font-extrabold">
                      {m.name.charAt(0).toUpperCase()}
                      <span className={cn('border-card absolute -right-0.5 -bottom-0.5 size-[0.8em] rounded-full border-2', m.presence === 'online' ? 'bg-tone-mint-ink' : 'bg-amber-500')} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold">{m.name}</span>
                      <span className="text-muted-foreground block text-[0.8em]">
                        {t('memberLine', { open: m.open, online: formatMinutes(data.online.get(m.userId)) })}
                      </span>
                    </span>
                    {m.waiting > 0 && (
                      <span className={cn('rounded-full px-3 py-1 text-[0.85em] font-extrabold tabular-nums', m.late ? 'bg-tone-salmon-ink text-white' : 'bg-card')}>
                        {t('waitingBadge', { n: m.waiting, time: m.oldestWaitMinutes === null ? '' : formatDuration(m.oldestWaitMinutes) })}
                      </span>
                    )}
                  </li>
                ))}
                {working.length === 0 && <li className="text-muted-foreground">{t('nobodyOnline')}</li>}
              </ul>
              {offline.length > 0 && (
                <p className="text-muted-foreground mt-[1vh] truncate text-[0.8em]">
                  {t('offline')}: {offline.map((m) => m.name.split(' ')[0]).join(', ')}
                </p>
              )}
            </Panel>

            {/* Ranking + goals */}
            <div className="flex min-h-0 flex-col gap-[1.6vh]">
              <Panel title={t('ranking')}>
                {data.ranking.length === 0 ? (
                  <p className="text-muted-foreground">{t('rankingEmpty')}</p>
                ) : (
                  <ol className="flex flex-col gap-[0.8vh]">
                    {data.ranking.map((r, i) => (
                      <li key={r.user_id} className="flex items-center gap-3">
                        <span className={cn('flex size-[1.9em] shrink-0 items-center justify-center rounded-full text-[0.9em] font-extrabold', i === 0 ? 'bg-amber-400 text-black' : i === 1 ? 'bg-zinc-300 text-black' : i === 2 ? 'bg-orange-300 text-black' : 'bg-muted')}>
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-bold">{r.name}</span>
                        <span className="text-[0.9em] font-extrabold tabular-nums">
                          {r.won_value > 0 ? formatCurrency(r.won_value, defaultCurrency) : r.appointments > 0 ? t('apptsShort', { n: r.appointments }) : t('repliesShort', { n: r.replies })}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>
              {data.goals.length > 0 && (
                <Panel title={t('goals')}>
                  <div className="flex flex-col gap-[1.2vh]">
                    {data.goals.map((g) => {
                      const pct = progressPct(g.actual, g.target) ?? 0;
                      return (
                        <div key={g.metric}>
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-semibold">{tg(`metric.${g.metric}`)}</span>
                            <span className="font-extrabold tabular-nums">{pct}%</span>
                          </div>
                          <div className="bg-muted mt-1 h-[1.1vh] min-h-2 overflow-hidden rounded-full">
                            <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-tone-mint-ink' : pct < pace ? 'bg-tone-salmon-ink' : 'bg-foreground')} style={{ width: `${Math.min(pct, 100)}%` }} />
                          </div>
                        </div>
                      );
                    })}
                    <p className="text-muted-foreground text-[0.75em]">{t('pace', { pace })}</p>
                  </div>
                </Panel>
              )}
            </div>

            {/* Feed */}
            <Panel title={t('feed')}>
              {data.feed.length === 0 ? (
                <p className="text-muted-foreground">{t('feedEmpty')}</p>
              ) : (
                <ul className="flex flex-col gap-[1vh]">
                  {data.feed.map((f, i) => {
                    const Icon = f.kind === 'won' ? Trophy : f.kind === 'appointment' ? CalendarCheck : UserPlus;
                    return (
                      <li key={`${f.kind}:${f.at}:${i}`} className={cn('flex items-start gap-3 rounded-[16px] px-3 py-[0.9vh]', i === 0 && 'bg-muted/60')}>
                        <Icon className={cn('mt-0.5 size-[1.1em] shrink-0', f.kind === 'won' ? 'text-amber-500' : f.kind === 'appointment' ? 'text-tone-mint-ink' : 'text-primary')} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold">
                            {f.kind === 'won'
                              ? t('feedWon', { who: f.who ?? t('someone'), value: formatCurrency(f.amount ?? 0, defaultCurrency) })
                              : f.kind === 'appointment'
                                ? t('feedAppt', { title: f.title })
                                : t('feedLead', { name: f.title })}
                          </span>
                          <span className="text-muted-foreground block truncate text-[0.8em]">
                            {format(new Date(f.at), 'HH:mm')}
                            {f.kind === 'won' && f.title ? ` · ${f.title}` : f.who ? ` · ${f.who}` : ''}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, hint, tone, icon }: { label: string; value: string; hint: string; tone?: 'warn' | 'ok'; icon?: React.ReactNode }) {
  return (
    <div className={cn('border-border flex flex-col gap-[0.4vh] rounded-[24px] border p-[2vh]', tone === 'warn' ? 'bg-tone-salmon-soft border-transparent' : 'bg-card')}>
      <span className="text-muted-foreground flex items-center gap-1.5 text-[0.85em] font-bold">{icon}{label}</span>
      <span className={cn('text-[2.6em] leading-none font-extrabold tracking-tight tabular-nums', tone === 'warn' && 'text-tone-salmon-ink')}>{value}</span>
      <span className="text-muted-foreground text-[0.8em]">{hint}</span>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-border bg-card flex min-h-0 flex-col overflow-hidden rounded-[24px] border p-[2vh]">
      <h2 className="mb-[1.2vh] text-[1.1em] font-extrabold">{title}</h2>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}
