'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ClipboardList } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

interface OpenCase {
  id: string;
  status: 'awaiting_human' | 'awaiting_lead';
}

/**
 * "Caso aberto" in the thread header (human cases, specs/human-cases.md):
 * the conversation has a task the AI handed to the team (amber) or is
 * waiting on the customer for it. Links to the cases screen. Live through
 * Realtime (migration 093); renders nothing when nothing is open.
 */
export function CaseChip({
  conversationId,
}: {
  conversationId: string | null | undefined;
}) {
  const t = useTranslations('Inbox.messageThread');
  const [cases, setCases] = useState<OpenCase[]>([]);

  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    const supabase = createClient();
    const load = () =>
      supabase
        .from('human_cases')
        .select('id, status')
        .eq('conversation_id', conversationId)
        .in('status', ['awaiting_human', 'awaiting_lead'])
        .then(({ data }) => {
          if (alive) setCases((data as OpenCase[] | null) ?? []);
        });
    void load();
    const channel = supabase
      .channel(`case-chip-${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'human_cases',
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => void load()
      )
      .subscribe();
    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, [conversationId]);

  if (!conversationId || cases.length === 0) return null;
  const team = cases.some((c) => c.status === 'awaiting_human');

  return (
    <Link
      href="/cases"
      title={t(team ? 'caseWaitingTeam' : 'caseWaitingCustomer')}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-4 font-semibold',
        team
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          : 'bg-muted text-muted-foreground'
      )}
    >
      <ClipboardList className="h-3 w-3" />
      {cases.length > 1
        ? t('caseCount', { count: cases.length })
        : t('caseOne')}
    </Link>
  );
}
