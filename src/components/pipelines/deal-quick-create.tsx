'use client';

import { useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { qk } from '@/lib/query/keys';
import type { ContactLite } from '@/hooks/queries/use-crm-lookups';
import { ContactPicker } from '@/components/pipelines/contact-picker';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PipelineStage } from '@/types';

const DESKTOP = '(min-width: 1024px)';
function subscribeDesktop(cb: () => void) {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
const readDesktop = () => window.matchMedia(DESKTOP).matches;

/**
 * v8 quick create: only what a deal needs to exist — what's being sold, the
 * client, the value and the stage. Owner, close date and notes are filled
 * in later on the deal view ("Criar e abrir ficha" jumps straight there).
 * A small dialog on desktop, a bottom sheet on phones.
 */
export function DealQuickCreate({
  open,
  onOpenChange,
  pipelineId,
  stages,
  defaultStageId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  /** Called with the new deal's id; `openPanel` when the user asked to open it. */
  onCreated: (dealId: string, openPanel: boolean) => void;
}) {
  const isDesktop = useSyncExternalStore(
    subscribeDesktop,
    readDesktop,
    () => true
  );
  const t = useTranslations('Pipelines.panel');
  const body = open ? (
    <QuickCreateForm
      pipelineId={pipelineId}
      stages={stages}
      defaultStageId={defaultStageId}
      onDone={(id, openPanel) => {
        onOpenChange(false);
        onCreated(id, openPanel);
      }}
    />
  ) : null;

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 p-0 sm:max-w-[480px]">
          <DialogTitle className="px-6 pt-5 pb-1 text-xl font-extrabold tracking-[-0.01em]">
            {t('quickTitle')}
          </DialogTitle>
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="max-h-[92dvh] gap-0 overflow-y-auto p-0"
      >
        <div className="flex justify-center pt-2.5 pb-1" aria-hidden>
          <span className="bg-border h-1.5 w-11 rounded-full" />
        </div>
        <SheetTitle className="px-5 pt-1 pb-1 text-xl font-extrabold">
          {t('quickTitle')}
        </SheetTitle>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function QuickCreateForm({
  pipelineId,
  stages,
  defaultStageId,
  onDone,
}: {
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  onDone: (dealId: string, openPanel: boolean) => void;
}) {
  const t = useTranslations('Pipelines.panel');
  const tf = useTranslations('Pipelines.form');
  const { accountId, defaultCurrency } = useAuth();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [contact, setContact] = useState<ContactLite | null>(null);
  const [value, setValue] = useState('');
  const [stageId, setStageId] = useState(defaultStageId || stages[0]?.id || '');
  const [busy, setBusy] = useState<false | 'plain' | 'open'>(false);

  const ready = !!title.trim() && !!contact && !!stageId;

  async function create(openPanel: boolean) {
    if (!ready || busy) {
      if (!ready) toast.error(tf('toastRequired'));
      return;
    }
    setBusy(openPanel ? 'open' : 'plain');
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.user || !accountId) {
      toast.error(
        session?.user ? tf('toastNotLinked') : tf('toastNotSignedIn')
      );
      setBusy(false);
      return;
    }
    const { data, error } = await supabase
      .from('deals')
      .insert({
        title: title.trim(),
        value: Number(value.replace(',', '.')) || 0,
        currency: defaultCurrency,
        contact_id: contact!.id,
        pipeline_id: pipelineId,
        stage_id: stageId,
        status: 'open',
        user_id: session.user.id,
        account_id: accountId,
      })
      .select('id')
      .single();
    if (error || !data) {
      toast.error(tf('toastFailedCreate'));
      setBusy(false);
      return;
    }
    await queryClient.invalidateQueries({
      queryKey: qk.deals(accountId, pipelineId),
    });
    const stageName = stages.find((s) => s.id === stageId)?.name ?? '';
    if (!openPanel) {
      toast.success(t('createdIn', { stage: stageName }), {
        action: { label: t('openPanel'), onClick: () => onDone(data.id, true) },
      });
    }
    onDone(data.id, openPanel);
  }

  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void create(false);
      }}
    >
      <div className="flex flex-col gap-4 px-5 pt-3 pb-2 lg:px-6">
        <label className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[12.5px] font-bold">
            {t('whatSold')}
          </span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tf('titlePlaceholder')}
            className="border-border bg-card text-foreground focus:border-foreground rounded-2xl border-[1.5px] px-3.5 py-3 text-base font-bold transition-colors duration-150 ease-out outline-none"
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[12.5px] font-bold">
            {t('client')}
          </span>
          <ContactPicker value={contact} onChange={setContact} />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1.5fr]">
          <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[12.5px] font-bold">
              {tf('value')} ({defaultCurrency})
            </span>
            <input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0"
              className="border-border bg-card text-foreground focus:border-foreground rounded-2xl border-[1.5px] px-3.5 py-3 text-base font-bold tabular-nums transition-colors duration-150 ease-out outline-none"
            />
          </label>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-muted-foreground text-[12.5px] font-bold">
              {tf('stage')}
            </span>
            <div className="-mx-5 flex [scrollbar-width:none] gap-1.5 overflow-x-auto px-5 sm:mx-0 sm:flex-wrap sm:px-0">
              {stages.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={s.id === stageId}
                  onClick={() => setStageId(s.id)}
                  className={cn(
                    'min-h-9 shrink-0 rounded-full border px-3 text-[12.5px] font-bold transition-colors duration-150 ease-out',
                    s.id === stageId
                      ? 'bg-foreground text-background border-transparent'
                      : 'border-border bg-card hover:bg-muted'
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="text-muted-foreground text-[12.5px]">{t('quickHint')}</p>
      </div>
      <div className="flex flex-col-reverse gap-2 px-5 pt-3 pb-5 sm:flex-row sm:items-center sm:justify-end lg:px-6">
        <span className="text-muted-foreground hidden text-xs sm:mr-auto sm:inline">
          {t('enterToCreate')}
        </span>
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4 sm:h-10"
          disabled={!!busy}
          onClick={() => void create(true)}
        >
          {busy === 'open' && <Loader2 className="size-4 animate-spin" />}
          {t('createAndOpen')}
        </Button>
        <Button
          type="submit"
          className="h-12 px-5 text-[15px] sm:h-10 sm:text-sm"
          disabled={!!busy}
        >
          {busy === 'plain' ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t('creating')}
            </>
          ) : (
            tf('createDeal')
          )}
        </Button>
      </div>
    </form>
  );
}
