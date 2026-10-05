'use client';

import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  CalendarDays,
  CircleDollarSign,
  Flag,
  Pencil,
  Plus,
  UserRound,
} from 'lucide-react';

import { useDealEvents, type DealEvent } from '@/hooks/queries/use-pipelines';
import type { ProfileLite } from '@/hooks/queries/use-crm-lookups';
import { formatRelative } from '@/lib/automations/trigger-meta';
import { APP_LOCALE, formatCurrency } from '@/lib/currency';
import type { PipelineStage } from '@/types';

const ICON: Record<DealEvent['kind'], typeof Plus> = {
  created: Plus,
  stage: ArrowRight,
  value: CircleDollarSign,
  owner: UserRound,
  status: Flag,
  title: Pencil,
  close_date: CalendarDays,
};

/**
 * "Histórico" in the deal view: one line per change, written by the
 * deals trigger (migration 104) whoever made it — a colleague, an
 * automation or the API. Hidden when the table isn't there yet.
 */
export function DealHistory({
  dealId,
  stages,
  profiles,
  currency,
}: {
  dealId: string;
  stages: PipelineStage[];
  profiles: ProfileLite[];
  currency: string;
}) {
  const t = useTranslations('Pipelines.history');
  const tRelative = useTranslations('Automations.relative');
  const { data: events, isError } = useDealEvents(dealId);
  if (isError || !events || events.length === 0) return null;

  const stageName = (id: unknown) =>
    stages.find((s) => s.id === id)?.name ?? t('unknown');
  const personByProfile = (id: unknown) =>
    profiles.find((p) => p.id === id)?.full_name ?? t('nobody');
  const actorName = (userId: string | null) =>
    userId
      ? (profiles.find((p) => p.user_id === userId)?.full_name ?? t('someone'))
      : t('system');
  const date = (v: unknown) =>
    typeof v === 'string'
      ? new Date(`${v}T12:00`).toLocaleDateString(APP_LOCALE)
      : t('noDate');

  function line(e: DealEvent): string {
    switch (e.kind) {
      case 'created':
        return t('created');
      case 'stage':
        return t('stage', {
          from: stageName(e.from_value),
          to: stageName(e.to_value),
        });
      case 'value':
        return t('value', {
          to: formatCurrency(Number(e.to_value ?? 0), currency),
        });
      case 'owner':
        return e.to_value
          ? t('owner', { to: personByProfile(e.to_value) })
          : t('ownerCleared');
      case 'status':
        return e.to_value === 'won' || e.to_value === 'lost'
          ? t(e.to_value)
          : t('reopened');
      case 'title':
        return t('title', { to: String(e.to_value ?? '') });
      case 'close_date':
        return e.to_value
          ? t('closeDate', { to: date(e.to_value) })
          : t('closeDateCleared');
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-bold">
        {t('heading')}
      </span>
      <ol className="flex flex-col">
        {events.map((e) => {
          const Icon = ICON[e.kind];
          return (
            <li key={e.id} className="flex items-start gap-3 py-1.5">
              <span className="bg-muted text-muted-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full">
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-snug font-semibold break-words">
                  {line(e)}
                </span>
                <span className="text-muted-foreground block text-[11.5px]">
                  {actorName(e.actor_user_id)} ·{' '}
                  {formatRelative(e.created_at, tRelative)}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
