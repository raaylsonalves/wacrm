'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { format, formatDistanceToNow } from 'date-fns';
import { ChevronRight, CornerUpLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { APP_LOCALE } from '@/lib/currency';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { cn } from '@/lib/utils';
import {
  CONVERSATION_SELECT,
  isSnoozed,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import { commandOf } from '@/lib/inbox/signals';
import {
  earliestByContact,
  workQueueOf,
  type UpcomingAppointment,
} from '@/lib/inbox/work-queue';
import { firstName, greetingFor } from '@/lib/today/summary';
import { splitByPriority, type PriorityReason } from '@/lib/today/priority';
import type { Conversation } from '@/types';

interface TodayAppointment {
  id: string;
  title: string;
  starts_at: string;
  conversation_id: string | null;
  contact: { name: string | null; phone: string } | null;
}

export interface TodayData {
  loaded: boolean;
  priority: { item: Conversation; reasons: PriorityReason[] }[];
  others: Conversation[];
  todayAppts: TodayAppointment[];
}

/**
 * The dashboard's "what now" data: the inbox's Reply queue (lib/inbox/
 * work-queue, so the dashboard and the Reply tab always agree), split
 * into priority and the rest (lib/today/priority), plus today's agenda.
 * Loaded once and shared by the greeting and the Conversations tab.
 */
export function useTodayData(): TodayData {
  const { accountId, user } = useAuth();
  const [now] = useState(() => new Date());
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [aiOn, setAiOn] = useState<boolean | undefined>(undefined);
  const [upcoming, setUpcoming] = useState<Map<string, UpcomingAppointment>>(() => new Map());
  const [todayAppts, setTodayAppts] = useState<TodayAppointment[]>([]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    const db = createClient();
    const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    (async () => {
      const [convRes, aiRes, apptRes] = await Promise.all([
        db
          .from('conversations')
          .select(CONVERSATION_SELECT)
          .eq('account_id', accountId)
          .neq('status', 'closed')
          .order('last_message_at', { ascending: false })
          .limit(300),
        db
          .from('ai_configs')
          .select('id')
          .eq('account_id', accountId)
          .eq('is_active', true)
          .eq('auto_reply_enabled', true)
          .limit(1),
        db
          .from('appointments')
          .select('id, contact_id, title, starts_at, conversation_id, contact:contacts(name, phone)')
          .eq('account_id', accountId)
          .in('status', ['scheduled', 'confirmed'])
          .gte('starts_at', now.toISOString())
          .order('starts_at', { ascending: true })
          .limit(500),
      ]);
      if (!alive) return;
      const appts = (apptRes.data ?? []) as unknown as (TodayAppointment & UpcomingAppointment)[];
      setConversations(normalizeConversations((convRes.data ?? []) as never));
      setAiOn(!aiRes.error && (aiRes.data ?? []).length > 0);
      setUpcoming(earliestByContact(appts));
      setTodayAppts(appts.filter((a) => new Date(a.starts_at) < tomorrowStart).slice(0, 6));
    })();
    return () => {
      alive = false;
    };
  }, [accountId, now]);

  return useMemo(() => {
    if (!conversations) return { loaded: false, priority: [], others: [], todayAppts };
    const ts = now.getTime();
    const commandFor = (c: Conversation) =>
      commandOf({
        status: c.status,
        assignedAgentId: c.assigned_agent_id,
        aiAutoreplyDisabled: c.ai_autoreply_disabled,
        aiOn,
      });
    const toReply = conversations.filter(
      (c) =>
        workQueueOf({
          command: commandFor(c),
          snoozed: isSnoozed(c, ts),
          lastSenderType: c.last_message_sender_type,
          lastMessageAt: c.last_message_at,
          nextAppointmentAt: c.contact_id ? upcoming.get(c.contact_id)?.starts_at : null,
          now: ts,
        }) === 'reply'
    );
    const split = splitByPriority(
      toReply,
      (c) => ({
        lastMessageAt: c.last_message_at,
        assignedAgentId: c.assigned_agent_id,
        handoffWaiting: commandFor(c) === 'waiting',
        hasOpenDeal: !!c.contact?.dealStage,
      }),
      user?.id,
      ts
    );
    return { loaded: true, ...split, todayAppts };
  }, [conversations, aiOn, upcoming, todayAppts, now, user?.id]);
}

export function TodayGreeting({ data }: { data: TodayData }) {
  const t = useTranslations('Today');
  const { profile } = useAuth();
  const [now] = useState(() => new Date());
  const hour = now.getHours();
  const total = data.priority.length + data.others.length;
  // "Sexta-feira, 3 de outubro" — Intl gives each locale its own word order.
  const dateLine = new Intl.DateTimeFormat(APP_LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  return (
    <header className="space-y-1">
      <p className="text-muted-foreground text-[13px] first-letter:uppercase">{dateLine}</p>
      <h1 className="text-foreground text-[26px] leading-tight font-bold tracking-tight sm:text-[28px]">
        {t(`greeting.${greetingFor(hour)}`, { name: firstName(profile?.full_name) })} 👋
      </h1>
      {!data.loaded ? (
        <div className="bg-muted h-5 w-64 animate-pulse rounded" />
      ) : (
        <p className="text-muted-foreground text-sm sm:text-base">
          <span className="text-foreground font-semibold">
            {total > 0 ? t('needReply', { count: total }) : t('allCaughtUp')}
          </span>
          {' · '}
          {total > 0 ? t('needReplyHint') : t('allCaughtUpHint')}
        </p>
      )}
    </header>
  );
}

const REASON_STYLE: Record<PriorityReason, string> = {
  handoff: 'bg-tone-salmon-soft text-tone-salmon-ink',
  mine: 'bg-tone-blue-soft text-tone-blue-ink',
  deal: '',
  fresh: 'bg-tone-mint-soft text-tone-mint-ink',
};

/** Conversations tab: priority cards, the other unanswered, today's agenda. */
export function PriorityPanel({ data }: { data: TodayData }) {
  const t = useTranslations('Today');

  if (!data.loaded) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="bg-muted/60 h-32 animate-pulse rounded-[20px]" />
        ))}
      </div>
    );
  }

  const empty = data.priority.length === 0 && data.others.length === 0;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {empty && (
          <p className="text-muted-foreground rounded-[20px] border border-dashed p-8 text-center text-sm">
            {t('noPriority')}
          </p>
        )}

        {data.priority.length > 0 && (
          <section className="space-y-3">
            <SectionTitle title={t('priority')} count={data.priority.length} />
            {data.priority.map(({ item, reasons }) => (
              <PriorityCard key={item.id} conversation={item} reasons={reasons} t={t} />
            ))}
          </section>
        )}

        {data.others.length > 0 && (
          <section className="space-y-3">
            <SectionTitle title={t('others')} count={data.others.length} />
            <div className="bg-card divide-border divide-y overflow-hidden rounded-[20px] border">
              {data.others.slice(0, 15).map((c) => (
                <OtherRow key={c.id} conversation={c} />
              ))}
            </div>
            {data.others.length > 15 && (
              <Link href="/inbox" className="text-primary flex items-center justify-end text-sm font-medium">
                {t('seeAll', { count: data.others.length })}
                <ChevronRight className="h-4 w-4" />
              </Link>
            )}
          </section>
        )}
      </div>

      <section className="space-y-3">
        <SectionTitle title={t('agendaToday')} count={data.todayAppts.length} />
        {data.todayAppts.length === 0 ? (
          <p className="text-muted-foreground rounded-[20px] border border-dashed p-6 text-center text-sm">
            {t('noAgenda')}
          </p>
        ) : (
          <div className="bg-card divide-border divide-y overflow-hidden rounded-[20px] border">
            {data.todayAppts.map((a) => (
              <Link
                key={a.id}
                href={a.conversation_id ? `/inbox?c=${a.conversation_id}` : '/agenda'}
                className="hover:bg-muted/50 flex items-center gap-3 px-4 py-3"
              >
                <span className="bg-tone-salmon-soft text-tone-salmon-ink w-14 shrink-0 rounded-full py-0.5 text-center text-xs font-bold tabular-nums">
                  {format(new Date(a.starts_at), 'HH:mm')}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-sm font-medium">{a.title}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {a.contact?.name || a.contact?.phone}
                  </span>
                </span>
                <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <h2 className="text-foreground flex items-center gap-2 text-base font-bold">
      {title}
      {count > 0 && (
        <span className="bg-muted text-muted-foreground rounded-full px-2 text-xs leading-5 tabular-nums">
          {count}
        </span>
      )}
    </h2>
  );
}

function Avatar({ c, size }: { c: Conversation; size: 'md' | 'sm' }) {
  const name = c.contact?.name || c.contact?.phone || '?';
  const dim = size === 'md' ? 'h-10 w-10' : 'h-9 w-9';
  return (
    <div
      className={cn(
        'bg-tone-lilac text-tone-on flex shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold',
        dim
      )}
    >
      {c.contact?.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={c.contact.avatar_url} alt="" className={cn(dim, 'object-cover')} />
      ) : (
        name.slice(0, 2).toUpperCase()
      )}
    </div>
  );
}

function when(iso: string | null | undefined) {
  return iso ? formatDistanceToNow(new Date(iso), { addSuffix: false, locale: dateFnsLocale }) : '';
}

function PriorityCard({
  conversation: c,
  reasons,
  t,
}: {
  conversation: Conversation;
  reasons: PriorityReason[];
  t: ReturnType<typeof useTranslations>;
}) {
  const contact = c.contact;
  const stage = contact?.dealStage;
  return (
    <div className="bg-card rounded-[20px] border p-4">
      <div className="flex items-start gap-3">
        <Avatar c={c} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-foreground truncate font-semibold">
              {contact?.name || contact?.phone}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">{when(c.last_message_at)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {contact?.company && (
              <span className="text-muted-foreground truncate text-xs">{contact.company}</span>
            )}
            {reasons.map((r) =>
              r === 'deal' && stage ? (
                <span
                  key={r}
                  className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{ backgroundColor: `${stage.color}22`, color: stage.color }}
                >
                  {stage.name}
                </span>
              ) : r !== 'deal' ? (
                <span key={r} className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', REASON_STYLE[r])}>
                  {t(`reason.${r}`)}
                </span>
              ) : null
            )}
          </div>
          <p className="text-foreground/90 mt-1.5 line-clamp-2 text-sm">{c.last_message_text}</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Link
              href={`/inbox?c=${c.id}&focus=1`}
              className="bg-foreground text-background hover:bg-foreground/90 flex h-10 items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold transition-colors duration-150 ease-out"
            >
              <CornerUpLeft className="h-4 w-4" />
              {t('reply')}
            </Link>
            <Link
              href={`/inbox?c=${c.id}`}
              className="border-border text-foreground hover:bg-muted flex h-10 items-center justify-center rounded-full border text-[13px] font-semibold transition-colors duration-150 ease-out"
            >
              {t('viewConversation')}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function OtherRow({ conversation: c }: { conversation: Conversation }) {
  const contact = c.contact;
  const stage = contact?.dealStage;
  return (
    <Link href={`/inbox?c=${c.id}`} className="hover:bg-muted/50 flex items-center gap-3 px-4 py-3">
      <Avatar c={c} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">
            {contact?.name || contact?.phone}
          </span>
          {stage && (
            <span
              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
              style={{ backgroundColor: `${stage.color}22`, color: stage.color }}
            >
              {stage.name}
            </span>
          )}
        </span>
        <span className="text-muted-foreground block truncate text-xs">{c.last_message_text}</span>
      </span>
      <span className="text-muted-foreground shrink-0 text-[11px]">{when(c.last_message_at)}</span>
      <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
    </Link>
  );
}
