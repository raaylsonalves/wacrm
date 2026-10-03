'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  Check,
  ChevronDown,
  Ellipsis,
  ExternalLink,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { qk } from '@/lib/query/keys';
import { useUpdateDeal, type DealPatch } from '@/hooks/queries/use-pipelines';
import {
  useLatestConversationId,
  useProfilesLite,
  type ContactLite,
} from '@/hooks/queries/use-crm-lookups';
import { CURRENCIES, formatCurrency } from '@/lib/currency';
import { InlineField } from '@/components/ui/inline-field';
import { ContactPicker } from '@/components/pipelines/contact-picker';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TONE_SOLID, toneFor } from '@/lib/tones';
import { cn } from '@/lib/utils';
import type { Deal, PipelineStage } from '@/types';

const DESKTOP = '(min-width: 1024px)';
function subscribeDesktop(cb: () => void) {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
const readDesktop = () => window.matchMedia(DESKTOP).matches;

/**
 * v8 deal view: the deal opens beside the board on desktop (a floating
 * card, the board stays visible) and as a bottom sheet with a grab handle
 * on phones. Every field edits in place and saves on its own through
 * useUpdateDeal (optimistic, rolled back on failure); the corner reads
 * "Salvando…" / "✓ Salvo". Esc closes.
 */
export function DealPanel({
  deal,
  stages,
  pipelineId,
  onClose,
}: {
  /** The deal from the board's cache; null closes the panel. */
  deal: Deal | null;
  stages: PipelineStage[];
  pipelineId: string;
  onClose: () => void;
}) {
  const isDesktop = useSyncExternalStore(
    subscribeDesktop,
    readDesktop,
    () => true
  );
  const t = useTranslations('Pipelines.panel');

  useEffect(() => {
    if (!deal || !isDesktop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deal, isDesktop, onClose]);

  if (isDesktop) {
    if (!deal) return null;
    return (
      <aside
        aria-label={t('title')}
        className="bg-card border-border animate-enter fixed top-3 right-3 bottom-3 z-40 flex w-[440px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-[24px] border shadow-[0_24px_60px_rgb(0_0_0/0.14)]"
      >
        <DealPanelBody
          key={deal.id}
          deal={deal}
          stages={stages}
          pipelineId={pipelineId}
          onClose={onClose}
        />
      </aside>
    );
  }

  return (
    <Sheet open={!!deal} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="h-[88dvh] gap-0 p-0"
      >
        <SheetTitle className="sr-only">{t('title')}</SheetTitle>
        <div className="flex justify-center pt-2.5 pb-1" aria-hidden>
          <span className="bg-border h-1.5 w-11 rounded-full" />
        </div>
        {deal && (
          <DealPanelBody
            key={deal.id}
            deal={deal}
            stages={stages}
            pipelineId={pipelineId}
            onClose={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function DealPanelBody({
  deal,
  stages,
  pipelineId,
  onClose,
}: {
  deal: Deal;
  stages: PipelineStage[];
  pipelineId: string;
  onClose: () => void;
}) {
  const t = useTranslations('Pipelines.panel');
  const tf = useTranslations('Pipelines.form');
  const { accountId, defaultCurrency } = useAuth();
  const queryClient = useQueryClient();
  const update = useUpdateDeal(pipelineId);
  const { data: profiles = [] } = useProfilesLite();
  const { data: conversationId } = useLatestConversationId(deal.contact_id);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [changingContact, setChangingContact] = useState(false);

  const save = (patch: DealPatch) => {
    setFailed(false);
    update.mutate(
      { id: deal.id, patch },
      {
        onSuccess: () => setSavedAt(Date.now()),
        onError: () => {
          setFailed(true);
          toast.error(tf('toastFailedSave'));
        },
      }
    );
  };

  const stage = stages.find((s) => s.id === deal.stage_id);
  const currency = deal.currency || defaultCurrency;
  const contactName =
    deal.contact?.name || deal.contact?.phone || t('noContact');
  const owner = profiles.find((p) => p.user_id === deal.assigned_to);
  const status = deal.status ?? 'open';

  async function remove() {
    const { error } = await createClient()
      .from('deals')
      .delete()
      .eq('id', deal.id);
    if (error) {
      toast.error(tf('toastFailedDelete'));
      return;
    }
    toast.success(tf('toastDeleted'));
    onClose();
    if (accountId)
      void queryClient.invalidateQueries({
        queryKey: qk.deals(accountId, pipelineId),
      });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top: stage, status chip, save state, actions */}
      <div className="flex items-center gap-1.5 px-4 pt-3.5 pb-2 lg:px-5">
        <DropdownMenu>
          <DropdownMenuTrigger className="border-border hover:bg-muted data-popup-open:bg-muted inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-bold transition-colors duration-150 ease-out">
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: stage?.color }}
            />
            {stage?.name ?? '—'}
            <ChevronDown className="text-muted-foreground size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            {stages.map((s) => (
              <DropdownMenuItem
                key={s.id}
                onClick={() =>
                  s.id !== deal.stage_id && save({ stage_id: s.id })
                }
              >
                <span
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="flex-1">{s.name}</span>
                {s.id === deal.stage_id && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {status !== 'open' && (
          <span
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[11.5px] font-bold',
              status === 'won'
                ? 'bg-tone-mint-soft text-tone-mint-ink'
                : 'bg-tone-pink-soft text-tone-pink-ink'
            )}
          >
            {status === 'won' ? t('wonChip') : t('lostChip')}
          </span>
        )}
        <span className="flex-1" />
        <SaveState
          pending={update.isPending}
          failed={failed}
          savedAt={savedAt}
        />
        <DropdownMenu onOpenChange={(o) => !o && setConfirmDelete(false)}>
          <DropdownMenuTrigger
            aria-label={t('moreActions')}
            className="hover:bg-muted flex size-9 items-center justify-center rounded-full transition-colors duration-150 ease-out"
          >
            <Ellipsis className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {conversationId && (
              <DropdownMenuItem
                render={<Link href={`/inbox?c=${conversationId}`} />}
              >
                <ExternalLink className="size-4" />
                {t('openConversation')}
              </DropdownMenuItem>
            )}
            {confirmDelete ? (
              <div className="flex flex-col gap-2 px-2.5 py-2">
                <span className="text-sm font-semibold">
                  {tf('deletePrompt')}
                </span>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={remove}
                    className="bg-tone-pink-soft text-tone-pink-ink min-h-8 rounded-full px-3 text-[12.5px] font-bold"
                  >
                    {tf('deleteDeal')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="bg-muted min-h-8 rounded-full px-3 text-[12.5px] font-semibold"
                  >
                    {tf('cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <DropdownMenuItem
                variant="destructive"
                closeOnClick={false}
                onClick={() => setConfirmDelete(true)}
              >
                {tf('deleteDeal')}…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="hover:bg-muted flex size-9 items-center justify-center rounded-full transition-colors duration-150 ease-out"
        >
          <X className="size-4.5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-1 pb-6 lg:px-5">
        <InlineField
          layout="bare"
          label={tf('title')}
          value={deal.title}
          onSave={(v) => v && save({ title: v })}
          display={
            <span className="text-[22px] leading-tight font-extrabold tracking-[-0.02em]">
              {deal.title}
            </span>
          }
          inputClassName="text-lg font-bold"
          className="mx-0 w-full"
        />

        {/* Client */}
        {changingContact ? (
          <ContactPicker
            autoFocus
            value={null}
            onChange={(c: ContactLite | null) => {
              setChangingContact(false);
              if (c && c.id !== deal.contact_id) save({ contact_id: c.id });
            }}
          />
        ) : (
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-bold',
                TONE_SOLID[toneFor(contactName)]
              )}
            >
              {contactName.slice(0, 2).toUpperCase()}
            </span>
            <button
              type="button"
              onClick={() => setChangingContact(true)}
              className="flex min-w-0 flex-1 flex-col text-left"
            >
              <strong className="truncate text-[14.5px]">{contactName}</strong>
              <span className="text-muted-foreground truncate text-[12.5px]">
                {deal.contact?.name ? deal.contact.phone : t('change')}
              </span>
            </button>
            {conversationId && (
              <Link
                href={`/inbox?c=${conversationId}`}
                className="border-border hover:bg-muted inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] font-bold transition-colors duration-150 ease-out"
              >
                {t('openConversation')}
                <ExternalLink className="size-3.5" />
              </Link>
            )}
          </div>
        )}

        {/* Value + result */}
        <div className="bg-muted/60 flex flex-col gap-2.5 rounded-[20px] p-4">
          <span className="text-muted-foreground text-xs font-bold">
            {tf('value')}
          </span>
          <InlineField
            layout="bare"
            label={tf('value')}
            type="number"
            inputMode="decimal"
            value={String(deal.value ?? 0)}
            onSave={(v) => save({ value: Number(v.replace(',', '.')) || 0 })}
            display={
              <span className="text-[30px] leading-none font-extrabold tracking-[-0.02em] tabular-nums">
                {formatCurrency(deal.value ?? 0, currency)}
              </span>
            }
            inputClassName="text-xl font-bold"
            className="mx-0 w-full"
          />
          <div
            role="group"
            aria-label={tf('status')}
            className="grid grid-cols-2 gap-2"
          >
            <button
              type="button"
              aria-pressed={status === 'won'}
              onClick={() =>
                save({ status: status === 'won' ? 'open' : 'won' })
              }
              className={cn(
                'min-h-11 rounded-full border text-[13.5px] font-bold transition-colors duration-150 ease-out',
                status === 'won'
                  ? 'bg-tone-mint-soft text-tone-mint-ink border-tone-mint-ink border-2'
                  : 'bg-card border-border hover:bg-muted'
              )}
            >
              ✓ {t('won')}
            </button>
            <button
              type="button"
              aria-pressed={status === 'lost'}
              onClick={() =>
                save({ status: status === 'lost' ? 'open' : 'lost' })
              }
              className={cn(
                'min-h-11 rounded-full border text-[13.5px] font-bold transition-colors duration-150 ease-out',
                status === 'lost'
                  ? 'bg-tone-pink-soft text-tone-pink-ink border-tone-pink-ink border-2'
                  : 'bg-card border-border hover:bg-muted'
              )}
            >
              ✕ {t('lost')}
            </button>
          </div>
        </div>

        {/* Details */}
        <div className="flex flex-col">
          <span className="text-muted-foreground mb-1 text-xs font-bold">
            {t('details')}
          </span>
          <InlineField
            label={tf('expectedCloseDate')}
            type="date"
            value={deal.expected_close_date ?? ''}
            placeholder="—"
            onSave={(v) => save({ expected_close_date: v || null })}
            display={
              deal.expected_close_date
                ? new Date(
                    `${deal.expected_close_date}T12:00:00`
                  ).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })
                : undefined
            }
          />
          <PickRow
            label={tf('assignedTo')}
            value={owner?.full_name ?? tf('unassigned')}
            options={[
              { id: '', label: tf('unassigned') },
              ...profiles.map((p) => ({
                id: p.user_id,
                label: p.full_name ?? '—',
              })),
            ]}
            selected={deal.assigned_to ?? ''}
            onPick={(id) => save({ assigned_to: id || null })}
          />
          <PickRow
            label={tf('currency')}
            value={currency}
            options={CURRENCIES.map((c) => ({
              id: c.code,
              label: `${c.code} · ${c.label}`,
            }))}
            selected={currency}
            onPick={(id) => save({ currency: id })}
          />
          {deal.conversation_id && (
            <div className="flex min-h-11 items-center gap-3">
              <span className="text-muted-foreground w-36 shrink-0 text-[12.5px]">
                {t('origin')}
              </span>
              <span className="bg-tone-lilac-soft text-tone-lilac-ink ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11.5px] font-bold">
                <Sparkles className="size-3" />
                {t('fromConversation')}
              </span>
            </div>
          )}
        </div>

        {/* Notes */}
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs font-bold">
            {tf('notes')}
          </span>
          <InlineField
            layout="bare"
            multiline
            label={tf('notes')}
            value={deal.notes ?? ''}
            placeholder={tf('notesPlaceholder')}
            onSave={(v) => save({ notes: v || null })}
            className="bg-muted/60 mx-0 w-full items-start py-3 font-medium"
          />
        </div>
      </div>
      <p className="text-muted-foreground border-border hidden border-t px-5 py-2.5 text-xs lg:block">
        {t('hint')}
      </p>
    </div>
  );
}

/** "Tudo salvo" at rest, "Salvando…" while writing, a mint "✓ Salvo" flash after. */
function SaveState({
  pending,
  failed,
  savedAt,
}: {
  pending: boolean;
  failed: boolean;
  savedAt: number | null;
}) {
  const t = useTranslations('Pipelines.panel');
  if (failed)
    return (
      <span className="text-tone-pink-ink text-xs font-semibold">
        {t('saveFailed')}
      </span>
    );
  if (pending)
    return (
      <span className="text-muted-foreground text-xs font-semibold">
        {t('saving')}
      </span>
    );
  return (
    <span
      className="relative inline-grid text-xs font-semibold"
      aria-live="polite"
    >
      <span
        key={`a-${savedAt ?? 0}`}
        className={cn(
          'text-muted-foreground col-start-1 row-start-1',
          savedAt && 'save-flash-label'
        )}
      >
        {t('allSaved')}
      </span>
      {savedAt && (
        <span
          key={`b-${savedAt}`}
          className="save-flash-done text-tone-mint-ink col-start-1 row-start-1"
        >
          ✓ {t('saved')}
        </span>
      )}
    </span>
  );
}

/** A details row that opens a short menu of choices (owner, currency). */
function PickRow({
  label,
  value,
  options,
  selected,
  onPick,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  selected: string;
  onPick: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="hover:bg-muted data-popup-open:bg-muted -mx-2.5 flex min-h-11 w-[calc(100%+1.25rem)] items-center gap-3 rounded-[14px] px-2.5 text-left transition-colors duration-150 ease-out">
        <span className="text-muted-foreground w-36 shrink-0 text-[12.5px]">
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-sm font-semibold">
          {value}
        </span>
        <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-64">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.id || 'none'}
            onClick={() => o.id !== selected && onPick(o.id)}
          >
            <span className="flex-1 truncate">{o.label}</span>
            {o.id === selected && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
