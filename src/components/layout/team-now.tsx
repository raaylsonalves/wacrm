'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import { PRESENCE_DOT_CLASS } from '@/components/presence/presence-dot';
import { TONE_SOLID, toneFor } from '@/lib/tones';
import { cn } from '@/lib/utils';

interface Member {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
}

/** Shown at most — the roster in Settings → Members has everyone. */
const MAX_PEOPLE = 4;

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/**
 * "Equipe agora" block of the v2 sidebar: the AI agent while it is
 * answering (with how many open conversations it holds) and the
 * teammates who are online or away right now. Offline people are left
 * out — this is "who can pick up a chat", not the member list.
 */
export function TeamNow() {
  const t = useTranslations('Sidebar.team');
  const { accountId, user } = useAuth();
  const { getPresence } = usePresence();
  const [members, setMembers] = useState<Member[]>([]);
  const [ai, setAi] = useState<{ name: string; count: number } | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    const db = createClient();
    const load = async () => {
      const [people, agents, held] = await Promise.all([
        db
          .from('profiles')
          .select('user_id, full_name, avatar_url')
          .eq('account_id', accountId)
          .order('full_name'),
        db
          .from('ai_configs')
          .select('name, is_default')
          .eq('account_id', accountId)
          .eq('is_active', true)
          .eq('auto_reply_enabled', true)
          .order('is_default', { ascending: false })
          .limit(1),
        // Open, nobody assigned and the bot not paused: the AI holds it.
        db
          .from('conversations')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .neq('status', 'closed')
          .is('assigned_agent_id', null)
          .eq('ai_autoreply_disabled', false),
      ]);
      if (!alive) return;
      setMembers((people.data as Member[] | null) ?? []);
      const agent = (agents.data ?? [])[0] as { name: string } | undefined;
      setAi(agent ? { name: agent.name, count: held.count ?? 0 } : null);
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [accountId]);

  const present = members
    .map((m) => ({ ...m, status: getPresence(m.user_id) }))
    .filter((m) => m.status !== 'offline')
    // You first, then online before away.
    .sort(
      (a, b) =>
        Number(b.user_id === user?.id) - Number(a.user_id === user?.id) ||
        (a.status === b.status ? 0 : a.status === 'online' ? -1 : 1)
    );

  if (!ai && present.length === 0) return null;

  return (
    <section aria-label={t('title')} className="mt-3">
      <p className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-semibold">
        {t('title')}
      </p>
      <ul className="flex flex-col gap-0.5">
        {ai && (
          <Row
            label={ai.name}
            detail={t('aiChats', { count: ai.count })}
            avatar={
              <span className="bg-tone-mint text-tone-on">
                {t('aiInitials')}
              </span>
            }
            dot="bg-emerald-500"
          />
        )}
        {present.slice(0, MAX_PEOPLE).map((m) => {
          const name = m.full_name || t('noName');
          return (
            <Row
              key={m.user_id}
              label={m.user_id === user?.id ? t('you', { name }) : name}
              detail={t(m.status)}
              avatar={
                m.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- user-supplied avatar URL
                  <img src={m.avatar_url} alt="" className="object-cover" />
                ) : (
                  <span className={TONE_SOLID[toneFor(name)]}>
                    {initials(name)}
                  </span>
                )
              }
              dot={PRESENCE_DOT_CLASS[m.status]}
            />
          );
        })}
        {present.length > MAX_PEOPLE && (
          <li className="text-muted-foreground px-3 py-1 text-xs">
            {t('more', { count: present.length - MAX_PEOPLE })}
          </li>
        )}
      </ul>
    </section>
  );
}

function Row({
  label,
  detail,
  avatar,
  dot,
}: {
  label: string;
  detail: string;
  avatar: React.ReactNode;
  dot: string;
}) {
  return (
    <li className="flex items-center gap-2.5 px-3 py-1">
      <span className="relative shrink-0">
        <span className="flex size-[30px] items-center justify-center overflow-hidden rounded-full text-[11px] font-bold [&>*]:flex [&>*]:size-full [&>*]:items-center [&>*]:justify-center">
          {avatar}
        </span>
        <span
          className={cn(
            'border-card absolute -right-px -bottom-px size-[9px] rounded-full border-2',
            dot
          )}
          aria-hidden
        />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground truncate text-[13px] font-semibold">
          {label}
        </span>
        <span className="text-muted-foreground truncate text-[11.5px]">
          {detail}
        </span>
      </span>
    </li>
  );
}
