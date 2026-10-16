'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { LOSS_REASONS, type LossReason } from '@/lib/leads/origin';
import { cn } from '@/lib/utils';
import { useSegment } from '@/hooks/use-segment';

/**
 * Asked when a deal is marked lost (migration 134): one reason, required,
 * plus an optional note. "Sugerir" reads the contact's conversation with
 * the account's AI key and pre-selects a reason; the person confirms.
 */
export function LossReasonPicker({
  initialReason,
  initialNote,
  conversationId,
  onConfirm,
  onCancel,
}: {
  initialReason?: string | null;
  initialNote?: string | null;
  conversationId?: string | null;
  onConfirm: (reason: LossReason, note: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('Pipelines.loss');
  const [reason, setReason] = useState<LossReason | null>(
    (LOSS_REASONS as readonly string[]).includes(initialReason ?? '') ? (initialReason as LossReason) : null
  );
  const [note, setNote] = useState(initialNote ?? '');
  const [suggesting, setSuggesting] = useState(false);
  const { profile } = useSegment();

  async function suggest() {
    if (!conversationId) return;
    setSuggesting(true);
    try {
      const res = await fetch('/api/ai/loss-reason', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.reason) {
        toast.error(body?.code === 'ai_not_configured' ? t('aiOff') : t('aiFailed'));
        return;
      }
      setReason(body.reason);
      if (body.note && !note.trim()) setNote(body.note);
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <div className="border-tone-pink-ink/30 bg-card flex flex-col gap-2.5 rounded-[16px] border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-bold">{t('question')}</span>
        {conversationId && (
          <button
            type="button"
            onClick={() => void suggest()}
            disabled={suggesting}
            className="text-primary hover:bg-muted inline-flex min-h-8 items-center gap-1 rounded-full px-2.5 text-xs font-semibold disabled:opacity-50"
          >
            {suggesting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {t('suggest')}
          </button>
        )}
      </div>
      <div role="radiogroup" aria-label={t('question')} className="flex flex-wrap gap-1.5">
        {profile.lossOrder.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reason === r}
            onClick={() => setReason(r)}
            className={cn(
              'min-h-9 rounded-full border px-3 text-[13px] font-semibold transition-colors',
              reason === r
                ? 'bg-tone-pink-soft text-tone-pink-ink border-tone-pink-ink'
                : 'border-border hover:bg-muted'
            )}
          >
            {t(`reason.${r}`)}
          </button>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder={t('notePlaceholder')}
        aria-label={t('notePlaceholder')}
        className="border-border bg-card-2 resize-none rounded-xl border px-3 py-2 text-[13px] outline-none focus:border-foreground/30"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="hover:bg-muted min-h-9 rounded-full px-3.5 text-[13px] font-semibold">
          {t('cancel')}
        </button>
        <button
          type="button"
          disabled={!reason}
          onClick={() => reason && onConfirm(reason, note.trim())}
          className="bg-foreground text-background min-h-9 rounded-full px-4 text-[13px] font-bold disabled:opacity-40"
        >
          {t('confirm')}
        </button>
      </div>
    </div>
  );
}
