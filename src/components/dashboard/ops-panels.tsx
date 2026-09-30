'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Bot, ChevronRight, ClipboardList, Users } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import {
  aiShare,
  heatLevel,
  heatmapMatrix,
  HEAT_ROWS,
  type HeatCell,
} from '@/lib/dashboard/ops';

interface TeamRow {
  user_id: string;
  name: string;
  replies: number;
  conversations: number;
  open: number;
}
interface AiVsTeam {
  ai_replies: number;
  team_replies: number;
  customer_messages: number;
  ai_conversations: number;
  team_conversations: number;
}
interface CaseRow {
  id: string;
  title: string;
  opened_at: string;
}

// A fixed hue, not the theme accent: a dark accent (navy) vanishes on a
// dark background and the heatmap reads as empty.
const HEAT_CLASS = [
  'bg-muted',
  'bg-sky-500/25',
  'bg-sky-500/45',
  'bg-sky-500/70',
  'bg-sky-500',
];

/**
 * Operations blocks under the dashboard charts: who on the team answered
 * today, how much the AI carried, cases waiting for a person, and when
 * customers write (last 30 days, weekday × hour). Counting happens in SQL
 * (migration 089, RLS-scoped); shaping in lib/dashboard/ops.
 */
export function OpsPanels() {
  const t = useTranslations('Dashboard.ops');
  const tDays = useTranslations('Agenda.weekdays');
  const { accountId } = useAuth();
  const [team, setTeam] = useState<TeamRow[] | null>(null);
  const [split, setSplit] = useState<AiVsTeam | null>(null);
  const [tokens, setTokens] = useState<number | null>(null);
  const [cases, setCases] = useState<{ count: number; rows: CaseRow[] } | null>(
    null
  );
  const [heat, setHeat] = useState<HeatCell[] | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    const db = createClient();
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).toISOString();
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();

    (async () => {
      const [
        teamRes,
        profRes,
        convRes,
        splitRes,
        tokRes,
        caseRes,
        settingsRes,
      ] = await Promise.all([
        db.rpc('dashboard_team_since', {
          p_account: accountId,
          p_since: todayStart,
        }),
        db
          .from('profiles')
          .select('user_id, full_name, account_role')
          .eq('account_id', accountId)
          .in('account_role', ['owner', 'admin', 'agent']),
        db
          .from('conversations')
          .select('assigned_agent_id')
          .eq('account_id', accountId)
          .neq('status', 'closed')
          .not('assigned_agent_id', 'is', null),
        db.rpc('dashboard_ai_vs_team', {
          p_account: accountId,
          p_since: todayStart,
        }),
        // Admin-only by RLS (spend is billing-class): others see no tokens.
        db
          .from('ai_usage_log')
          .select('total_tokens')
          .eq('account_id', accountId)
          .gte('created_at', todayStart),
        db
          .from('human_cases')
          .select('id, title, opened_at', { count: 'exact' })
          .eq('account_id', accountId)
          .eq('status', 'awaiting_human')
          .order('opened_at', { ascending: true })
          .limit(3),
        db
          .from('appointment_settings')
          .select('timezone')
          .eq('account_id', accountId)
          .maybeSingle(),
      ]);
      const tz =
        (settingsRes.data?.timezone as string | undefined) ??
        'America/Sao_Paulo';
      const heatRes = await db.rpc('dashboard_inbound_heatmap', {
        p_account: accountId,
        p_since: monthAgo,
        p_tz: tz,
      });
      if (!alive) return;

      const byUser = new Map(
        (
          (teamRes.data ?? []) as {
            user_id: string;
            replies: number;
            conversations: number;
          }[]
        ).map((r) => [r.user_id, r])
      );
      const openBy = new Map<string, number>();
      for (const c of (convRes.data ?? []) as { assigned_agent_id: string }[]) {
        openBy.set(
          c.assigned_agent_id,
          (openBy.get(c.assigned_agent_id) ?? 0) + 1
        );
      }
      setTeam(
        ((profRes.data ?? []) as { user_id: string; full_name: string }[])
          .map((p) => ({
            user_id: p.user_id,
            name: p.full_name,
            replies: Number(byUser.get(p.user_id)?.replies ?? 0),
            conversations: Number(byUser.get(p.user_id)?.conversations ?? 0),
            open: openBy.get(p.user_id) ?? 0,
          }))
          .sort((a, b) => b.replies - a.replies || b.open - a.open)
      );
      const s = ((splitRes.data ?? []) as AiVsTeam[])[0];
      setSplit(
        s
          ? {
              ai_replies: Number(s.ai_replies),
              team_replies: Number(s.team_replies),
              customer_messages: Number(s.customer_messages),
              ai_conversations: Number(s.ai_conversations),
              team_conversations: Number(s.team_conversations),
            }
          : null
      );
      setTokens(
        tokRes.error
          ? null
          : ((tokRes.data ?? []) as { total_tokens: number }[]).reduce(
              (sum, r) => sum + (r.total_tokens ?? 0),
              0
            )
      );
      setCases({
        count: caseRes.count ?? 0,
        rows: (caseRes.data ?? []) as CaseRow[],
      });
      setHeat((heatRes.data ?? []) as HeatCell[]);
    })();
    return () => {
      alive = false;
    };
  }, [accountId]);

  const share = split ? aiShare(split.ai_replies, split.team_replies) : null;
  const matrix = heat ? heatmapMatrix(heat) : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Team today */}
      <Panel icon={Users} title={t('team.title')}>
        {team === null ? (
          <Skeleton />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground text-xs">
                <th className="pb-2 text-left font-medium">
                  {t('team.person')}
                </th>
                <th className="pb-2 text-right font-medium">
                  {t('team.replies')}
                </th>
                <th className="pb-2 text-right font-medium">
                  {t('team.conversations')}
                </th>
                <th className="pb-2 text-right font-medium">
                  {t('team.open')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {team.map((r) => (
                <tr key={r.user_id}>
                  <td className="truncate py-1.5 pr-2">{r.name}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.replies}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.conversations}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{r.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {/* AI vs team */}
      <Panel icon={Bot} title={t('ai.title')}>
        {split === null ? (
          <Skeleton />
        ) : share === null ? (
          <p className="text-muted-foreground text-sm">{t('ai.none')}</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              <span className="text-2xl font-bold tabular-nums">{share}%</span>{' '}
              <span className="text-muted-foreground">{t('ai.share')}</span>
            </p>
            <div className="bg-muted flex h-2.5 overflow-hidden rounded-full">
              <div className="bg-sky-500" style={{ width: `${share}%` }} />
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Stat
                label={t('ai.aiReplies')}
                value={split.ai_replies}
                hint={t('ai.inConversations', {
                  count: split.ai_conversations,
                })}
              />
              <Stat
                label={t('ai.teamReplies')}
                value={split.team_replies}
                hint={t('ai.inConversations', {
                  count: split.team_conversations,
                })}
              />
              <Stat
                label={t('ai.customerMessages')}
                value={split.customer_messages}
              />
              {tokens !== null && (
                <Stat label={t('ai.tokens')} value={tokens} />
              )}
            </dl>
          </div>
        )}
      </Panel>

      {/* Cases waiting */}
      <Panel
        icon={ClipboardList}
        title={t('cases.title')}
        action={
          <Link
            href="/cases"
            className="text-primary flex items-center text-xs font-medium"
          >
            {t('cases.open')}
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        }
      >
        {cases === null ? (
          <Skeleton />
        ) : cases.count === 0 ? (
          <p className="text-muted-foreground text-sm">{t('cases.none')}</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">
              <span className="text-2xl font-bold tabular-nums">
                {cases.count}
              </span>{' '}
              <span className="text-muted-foreground">
                {t('cases.waiting', { count: cases.count })}
              </span>
            </p>
            <ul className="divide-border divide-y text-sm">
              {cases.rows.map((c) => (
                <li key={c.id} className="truncate py-1.5">
                  {c.title}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      {/* When customers write */}
      <Panel title={t('heat.title')} subtitle={t('heat.subtitle')}>
        {matrix === null ? (
          <Skeleton />
        ) : !matrix.peak ? (
          <p className="text-muted-foreground text-sm">{t('heat.none')}</p>
        ) : (
          <div className="space-y-2">
            <div className="overflow-x-auto">
              <div className="grid min-w-[420px] grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-0.5 text-[10px]">
                {HEAT_ROWS.map((dow, row) => (
                  <div key={dow} className="contents">
                    <span className="text-muted-foreground pr-1 leading-4">
                      {tDays(String(dow))}
                    </span>
                    {matrix.grid[row].map((n, h) => (
                      <span
                        key={h}
                        title={t('heat.cell', {
                          day: tDays(String(dow)),
                          hour: h,
                          count: n,
                        })}
                        className={cn(
                          'h-4 rounded-sm',
                          HEAT_CLASS[heatLevel(n, matrix.max)]
                        )}
                      />
                    ))}
                  </div>
                ))}
                <span />
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} className="text-muted-foreground text-center">
                    {h % 6 === 0 ? h : ''}
                  </span>
                ))}
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              {t('heat.peak', {
                day: tDays(String(matrix.peak.dow)),
                hour: matrix.peak.hour,
              })}
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Panel({
  icon: Icon,
  title,
  subtitle,
  action,
  children,
}: {
  icon?: typeof Users;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-card rounded-xl border p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
            {Icon && <Icon className="text-primary h-4 w-4" />}
            {title}
          </h3>
          {subtitle && (
            <p className="text-muted-foreground text-xs">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-semibold tabular-nums">
        {value.toLocaleString()}
        {hint && (
          <span className="text-muted-foreground ml-1 text-xs font-normal">
            {hint}
          </span>
        )}
      </dd>
    </div>
  );
}

function Skeleton() {
  return <div className="bg-muted/60 h-24 animate-pulse rounded-lg" />;
}
