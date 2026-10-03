'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useCan } from '@/hooks/use-can';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import type { ConversationSummary } from '@/lib/ai/summary';

/**
 * "Resumo e próximo passo" in the contact panel: what happened so far and
 * what the team should do next, written by the account's AI from the
 * conversation. On demand — a button, never automatic — because it spends
 * tokens on the account's own key. The last result is saved on the
 * conversation (migration 094) and shown with how old it is.
 */
export function ConversationSummaryCard({
  conversationId,
}: {
  conversationId: string;
}) {
  const t = useTranslations('Inbox.summary');
  const canAct = useCan('send-messages');
  const [data, setData] = useState<
    (ConversationSummary & { at: string }) | null
  >(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    createClient()
      .from('conversations')
      .select('ai_summary, ai_summary_at')
      .eq('id', conversationId)
      .maybeSingle()
      .then(({ data: row }) => {
        if (!alive) return;
        const s = row?.ai_summary as ConversationSummary | null | undefined;
        setData(
          s && row?.ai_summary_at
            ? { ...s, at: row.ai_summary_at as string }
            : null
        );
      });
    return () => {
      alive = false;
    };
  }, [conversationId]);

  async function generate() {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          d.code === 'ai_not_configured'
            ? t('notConfigured')
            : d.code === 'no_messages'
              ? t('noMessages')
              : t('failed')
        );
        return;
      }
      setData({
        summary: d.summary,
        next_step: d.next_step,
        at: d.generated_at,
      });
    } finally {
      setLoading(false);
    }
  }

  const refresh = canAct && data && (
    <button
      type="button"
      onClick={() => void generate()}
      disabled={loading}
      title={t('refresh')}
      aria-label={t('refresh')}
      className="hover:text-foreground ml-auto"
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
    </button>
  )

  // v2 contact column: the next step stands out on a solid lilac card,
  // the summary sits in its own card below it.
  return (
    <>
      {data?.next_step && (
        <div className="bg-tone-lilac text-tone-on flex flex-col gap-1.5 rounded-[22px] p-4">
          <span className="text-xs font-bold">{t('nextStep')}</span>
          <p className="text-[13.5px] leading-snug">{data.next_step}</p>
        </div>
      )}
      <div className="border-border bg-card rounded-[22px] border p-4">
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-bold">
          <Sparkles className="h-3 w-3" />
          {t('title')}
          {refresh}
        </div>

        {data ? (
          <div className="mt-2 space-y-2 text-[13px] leading-relaxed">
            <p className="text-foreground whitespace-pre-line">{data.summary}</p>
            <p className="text-muted-foreground text-[11px]">
              {t('updated', {
                when: formatDistanceToNow(new Date(data.at), {
                  addSuffix: true,
                  locale: dateFnsLocale,
                }),
              })}
            </p>
          </div>
        ) : (
          canAct && (
            <button
              type="button"
              onClick={() => void generate()}
              disabled={loading}
              className="text-muted-foreground hover:bg-muted hover:text-foreground mt-2 flex w-full items-center justify-center gap-2 rounded-full border border-dashed px-3 py-2 text-sm"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {t('generate')}
            </button>
          )
        )}
      </div>
    </>
  )
}
