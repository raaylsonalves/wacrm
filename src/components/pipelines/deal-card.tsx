'use client';

import type { Deal, PipelineStage } from '@/types';
import { Calendar, Check, X } from 'lucide-react';
import { formatCurrency, APP_LOCALE } from '@/lib/currency';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { TONE_SOLID, toneFor } from '@/lib/tones';

interface DealCardProps {
  deal: Deal;
  /** Kept for callers; the v2 card no longer paints the stage colour. */
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
  /** Open in the side view — outlined in ink. */
  selected?: boolean;
}

function formatDate(dateStr: string) {
  // expected_close_date is a bare "YYYY-MM-DD": parsed as-is it's UTC
  // midnight, which reads as the day before in Brazil. Noon local avoids it.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ? new Date(`${dateStr}T12:00:00`)
    : new Date(dateStr);
  return date.toLocaleDateString(APP_LOCALE, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || '?').trim();
  if (!source) return '?';
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, onEdit, isOverlay, selected }: DealCardProps) {
  const t = useTranslations('Pipelines.card');
  const contactLabel =
    deal.contact?.name || deal.contact?.phone || t('noContact');
  const assigneeLabel = deal.assignee?.full_name || null;

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      className={cn(
        'group border-border bg-card relative w-full cursor-pointer rounded-[20px] border p-3.5 text-left transition-[transform,box-shadow] duration-150 ease-out',
        isOverlay
          ? 'shadow-xl'
          : 'hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgb(0_0_0/0.08)]',
        selected && 'ring-foreground ring-2'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-foreground flex-1 text-sm leading-snug font-bold break-words">
          {deal.title}
        </h4>
        {deal.status === 'won' && (
          <span className="bg-tone-mint-soft text-tone-mint-ink inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold">
            <Check className="h-3 w-3" />
            {t('won')}
          </span>
        )}
        {deal.status === 'lost' && (
          <span className="bg-tone-pink-soft text-tone-pink-ink inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold">
            <X className="h-3 w-3" />
            {t('lost')}
          </span>
        )}
      </div>

      {/* Contact row */}
      <div className="mt-2 flex items-center gap-2">
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
            TONE_SOLID[toneFor(contactLabel)]
          )}
        >
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {contactLabel}
        </span>
      </div>

      <div className="border-border mt-3 flex items-center justify-between gap-2 border-t pt-2.5">
        <span className="text-foreground text-sm font-bold tabular-nums">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {deal.expected_close_date && (
          <span className="border-border text-muted-foreground flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
            <Calendar className="h-3 w-3" />
            {formatDate(deal.expected_close_date)}
          </span>
        )}
      </div>

      {assigneeLabel && (
        <div className="mt-2 flex items-center justify-end">
          <span
            title={assigneeLabel}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold',
              TONE_SOLID[toneFor(assigneeLabel)]
            )}
          >
            {initials(assigneeLabel)}
          </span>
        </div>
      )}
    </button>
  );
}
