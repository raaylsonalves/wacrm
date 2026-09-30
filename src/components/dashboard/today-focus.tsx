'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { format, formatDistanceToNow } from 'date-fns';
import { ChevronRight, CornerUpLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { dateFnsLocale } from '@/lib/date-fns-locale';
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
import type { Conversation } from '@/types';

interface TodayAppointment {
  id: string;
  title: string;
  starts_at: string;
  conversation_id: string | null;
  contact: { name: string | null; phone: string } | null;
}

/**
 * Top of the dashboard: what needs the agent now — the greeting, how many
 * conversations owe a reply (the inbox's own Reply queue, so the two always
 * agree), the most recent of them with a Reply button, and what is still on
 * today's agenda. The numbers below it are the dashboard's own metrics.
 */
export function TodayFocus() {
  const t = useTranslations('Today');
  const { profile, accountId } = useAuth();
  const [now] = useState(() => new Date());

  const [conversations, setConversations] = useState<Conversation[] | null>(
    null
  );
  const [aiOn, setAiOn] = useState<boolean | undefined>(undefined);
  const [upcoming, setUpcoming] = useState<Map<string, UpcomingAppointment>>(
    () => new Map()
  );
  const [todayAppts, setTodayAppts] = useState<TodayAppointment[]>([]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    const db = createClient();
    const tomorrowStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1
    );

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
          .select(
            'id, contact_id, title, starts_at, conversation_id, contact:contacts(name, phone)'
          )
          .eq('account_id', accountId)
          .in('status', ['scheduled', 'confirmed'])
          .gte('starts_at', now.toISOString())
          .order('starts_at', { ascending: true })
          .limit(500),
      ]);
      if (!alive) return;
      const appts = (apptRes.data ?? []) as unknown as (TodayAppointment &
        UpcomingAppointment)[];
      setConversations(normalizeConversations((convRes.data ?? []) as never));
      setAiOn(!aiRes.error && (aiRes.data ?? []).length > 0);
      setUpcoming(earliestByContact(appts));
      setTodayAppts(
        appts.filter((a) => new Date(a.starts_at) < tomorrowStart).slice(0, 5)
      );
    })();
    return () => {
      alive = false;
    };
  }, [accountId, now]);

  // The Reply queue, most recent first — a lead who just wrote is the
  // hottest; a weeks-old thread shouldn't crowd the top.
  const toReply = useMemo(() => {
    if (!conversations) return [];
    const ts = now.getTime();
    return conversations
      .filter(
        (c) =>
          workQueueOf({
            command: commandOf({
              status: c.status,
              assignedAgentId: c.assigned_agent_id,
              aiAutoreplyDisabled: c.ai_autoreply_disabled,
              aiOn,
            }),
            snoozed: isSnoozed(c, ts),
            lastSenderType: c.last_message_sender_type,
            lastMessageAt: c.last_message_at,
            nextAppointmentAt: c.contact_id
              ? upcoming.get(c.contact_id)?.starts_at
              : null,
            now: ts,
          }) === 'reply'
      )
      .sort((a, b) =>
        (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '')
      );
  }, [conversations, aiOn, upcoming, now]);

  const name = firstName(profile?.full_name);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-foreground text-2xl font-bold sm:text-3xl">
          {t(`greeting.${greetingFor(now.getHours())}`, { name })} 👋
        </h1>
        {conversations === null ? (
          <div className="bg-muted h-6 w-64 animate-pulse rounded" />
        ) : (
          <p className="text-muted-foreground text-sm sm:text-base">
            <span className="text-foreground font-semibold">
              {toReply.length > 0
                ? t('needReply', { count: toReply.length })
                : t('allCaughtUp')}
            </span>
            {' · '}
            {toReply.length > 0 ? t('needReplyHint') : t('allCaughtUpHint')}
          </p>
        )}
      </header>

      {(toReply.length > 0 || todayAppts.length > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {toReply.length > 0 && (
            <section
              className={
                todayAppts.length > 0
                  ? 'space-y-3 lg:col-span-2'
                  : 'space-y-3 lg:col-span-3'
              }
            >
              <div className="flex items-center justify-between">
                <h2 className="text-foreground font-semibold">
                  {t('priority')}
                </h2>
                <Link
                  href="/inbox"
                  className="text-primary flex items-center text-sm font-medium"
                >
                  {t('seeAll', { count: toReply.length })}
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {toReply.slice(0, 4).map((c) => (
                  <PriorityCard key={c.id} conversation={c} t={t} />
                ))}
              </div>
            </section>
          )}

          {todayAppts.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-foreground font-semibold">
                {t('agendaToday')}
              </h2>
              <div className="bg-card divide-y rounded-xl border">
                {todayAppts.map((a) => (
                  <Link
                    key={a.id}
                    href={
                      a.conversation_id
                        ? `/inbox?c=${a.conversation_id}`
                        : '/agenda'
                    }
                    className="hover:bg-muted/50 flex items-center gap-3 px-4 py-3"
                  >
                    <span className="text-primary w-12 shrink-0 text-sm font-semibold tabular-nums">
                      {format(new Date(a.starts_at), 'HH:mm')}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {a.title}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {a.contact?.name || a.contact?.phone}
                      </span>
                    </span>
                    <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function PriorityCard({
  conversation: c,
  t,
}: {
  conversation: Conversation;
  t: ReturnType<typeof useTranslations>;
}) {
  const contact = c.contact;
  const name = contact?.name || contact?.phone || '?';
  return (
    <div className="bg-card flex flex-col rounded-xl border p-4">
      <div className="flex flex-1 items-start gap-3">
        <div className="bg-primary/10 text-primary flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-semibold">
          {contact?.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={contact.avatar_url}
              alt=""
              className="h-11 w-11 object-cover"
            />
          ) : (
            name.slice(0, 2).toUpperCase()
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className="text-foreground truncate font-semibold">
              {name}
            </span>
            {c.last_message_at && (
              <span className="text-muted-foreground shrink-0 text-xs">
                {formatDistanceToNow(new Date(c.last_message_at), {
                  addSuffix: true,
                  locale: dateFnsLocale,
                })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {contact?.company && (
              <span className="text-muted-foreground truncate text-xs">
                {contact.company}
              </span>
            )}
            {contact?.dealStage && (
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                style={{
                  backgroundColor: `${contact.dealStage.color}22`,
                  color: contact.dealStage.color,
                }}
              >
                {contact.dealStage.name}
              </span>
            )}
          </div>
          <p className="text-foreground mt-1 line-clamp-2 text-sm">
            {c.last_message_text}
          </p>
        </div>
      </div>
      <Link
        href={`/inbox?c=${c.id}`}
        className="bg-primary text-primary-foreground hover:bg-primary/90 mt-3 flex h-10 items-center justify-center gap-2 rounded-lg text-sm font-semibold"
      >
        <CornerUpLeft className="h-4 w-4" />
        {t('reply')}
      </Link>
    </div>
  );
}
