'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useCan } from '@/hooks/use-can';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { PipelineStage } from '@/types';

/** Fired after the header chip moves a deal, so the list's chip follows. */
export const DEAL_STAGE_EVENT = 'wacrm:deal-stage-changed';

interface OpenDeal {
  id: string;
  stage_id: string;
  pipeline_id: string;
}

/**
 * The contact's funnel stage in the thread header ("Em negociação ⌄"),
 * movable from there. Reads the most recently touched open deal — the same
 * one the list's stage chip shows — and renders nothing without one.
 * The update goes straight to `deals` like the board's drag; RLS decides
 * who may move it and the DB trigger re-slots its position.
 */
export function DealStageChip({
  contactId,
}: {
  contactId: string | null | undefined;
}) {
  const t = useTranslations('Inbox.messageThread');
  const canEdit = useCan('send-messages');
  const [deal, setDeal] = useState<OpenDeal | null>(null);
  const [stages, setStages] = useState<PipelineStage[]>([]);

  useEffect(() => {
    let alive = true;
    const supabase = createClient();
    (async () => {
      if (!contactId) {
        if (alive) setDeal(null);
        return;
      }
      const { data } = await supabase
        .from('deals')
        .select('id, stage_id, pipeline_id')
        .eq('contact_id', contactId)
        .eq('status', 'open')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!alive) return;
      setDeal((data as OpenDeal | null) ?? null);
      if (!data) return;
      const { data: st } = await supabase
        .from('pipeline_stages')
        .select('*')
        .eq('pipeline_id', (data as OpenDeal).pipeline_id)
        .order('position', { ascending: true });
      if (alive) setStages((st as PipelineStage[] | null) ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [contactId]);

  const current = deal ? stages.find((s) => s.id === deal.stage_id) : undefined;
  if (!deal || !current) return null;

  async function move(stageId: string) {
    if (!deal || stageId === deal.stage_id) return;
    const prev = deal;
    setDeal({ ...deal, stage_id: stageId });
    const { data, error } = await createClient()
      .from('deals')
      .update({ stage_id: stageId })
      .eq('id', prev.id)
      .select('id');
    if (error || !data || data.length === 0) {
      setDeal(prev);
      toast.error(t('stageMoveFailed'));
      return;
    }
    // The conversation list carries its own copy of the stage; tell it.
    const moved = stages.find((s) => s.id === stageId);
    if (moved && contactId) {
      window.dispatchEvent(
        new CustomEvent(DEAL_STAGE_EVENT, { detail: { contactId, stage: moved } })
      );
    }
  }

  const chip = (
    <>
      <span className="truncate">{current.name}</span>
      {canEdit && <ChevronDown className="h-3 w-3 shrink-0" />}
    </>
  );
  const style = { backgroundColor: `${current.color}22`, color: current.color };
  const cls =
    'inline-flex max-w-[140px] items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4';

  if (!canEdit) {
    return (
      <span className={cls} style={style} title={t('dealStage')}>
        {chip}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cls} style={style} title={t('dealStage')}>
        {chip}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="border-border bg-popover w-52"
      >
        {stages.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onClick={() => void move(s.id)}
            className="text-sm"
          >
            <span
              className="mr-2 h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            <span className="flex-1 truncate">{s.name}</span>
            {s.id === deal.stage_id && <Check className="ml-2 h-3 w-3" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
