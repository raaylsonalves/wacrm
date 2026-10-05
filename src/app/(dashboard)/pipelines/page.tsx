'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  useDeals,
  useDealsRealtime,
  usePipelines,
  useStages,
  useUpdateDeal,
} from '@/hooks/queries/use-pipelines';
import { createClient } from '@/lib/supabase/client';
import type { Pipeline, Deal } from '@/types';
import { PipelineBoard } from '@/components/pipelines/pipeline-board';
import { PipelineSettings } from '@/components/pipelines/pipeline-settings';
import { DealPanel } from '@/components/pipelines/deal-panel';
import { DealQuickCreate } from '@/components/pipelines/deal-quick-create';
import { PipelineAnalytics } from '@/components/pipelines/pipeline-analytics';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GitBranch, Plus, ChevronDown, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different `useCan` capabilities,
// not on different copy.

// Spec-defined seed — colors per the product spec; names come from
// `Pipelines.page.defaultStageNames` (messages/*.json) so a seeded
// pipeline matches the app's locale instead of always being English.
const DEFAULT_STAGE_COLORS = [
  '#3b82f6', // blue
  '#eab308', // yellow
  '#f97316', // orange
  '#8b5cf6', // purple
  '#22c55e', // green
];

export default function PipelinesPage() {
  const t = useTranslations('Pipelines.page');
  const defaultStageNames = t.raw('defaultStageNames') as string[];
  const defaultStages = useMemo(
    () =>
      defaultStageNames.map((name, position) => ({
        name,
        color: DEFAULT_STAGE_COLORS[position],
        position,
      })),
    [defaultStageNames]
  );
  const supabase = createClient();
  const canEditSettings = useCan('edit-settings');
  const canCreateDeals = useCan('send-messages');
  const { accountId } = useAuth();
  const queryClient = useQueryClient();

  // Reads come from TanStack Query (hooks/queries/use-pipelines): cached
  // per account + pipeline, so leaving and coming back is instant and a
  // write refreshes exactly the lists it touched.
  const pipelinesQuery = usePipelines();
  const pipelines = useMemo(() => pipelinesQuery.data ?? [], [pipelinesQuery.data]);
  const [chosenPipelineId, setSelectedPipelineId] = useState<string>('');
  // The chosen pipeline while it still exists, otherwise the first one.
  const selectedPipelineId =
    chosenPipelineId && pipelines.some((p) => p.id === chosenPipelineId)
      ? chosenPipelineId
      : (pipelines[0]?.id ?? '');
  const stagesQuery = useStages(selectedPipelineId);
  const dealsQuery = useDeals(selectedPipelineId);
  useDealsRealtime(selectedPipelineId);
  const stages = useMemo(() => stagesQuery.data ?? [], [stagesQuery.data]);
  const deals = useMemo(() => dealsQuery.data ?? [], [dealsQuery.data]);
  const updateDeal = useUpdateDeal(selectedPipelineId);

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // v8: a deal opens in the side view (bottom sheet on phones) and a new
  // one starts in the small quick-create dialog. Both the top-bar "Add
  // Deal" and the per-column "+" open the same quick create.
  const [openDealId, setOpenDealId] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [defaultStageId, setDefaultStageId] = useState<string>('');
  const openDeal = deals.find((d) => d.id === openDealId) ?? null;

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);
  const [seeding, setSeeding] = useState(false);

  const seedDefaultPipeline =
    useCallback(async (): Promise<Pipeline | null> => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return null;
      // pipelines.account_id is NOT NULL post-017 with no DB default.
      if (!accountId) return null;

      const { data: pipeline, error } = await supabase
        .from('pipelines')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: t('defaultPipelineName'),
        })
        .select()
        .single();

      if (error || !pipeline) {
        console.error('Failed to seed pipeline:', error?.message);
        return null;
      }

      const stagesPayload = defaultStages.map((s) => ({
        pipeline_id: pipeline.id,
        name: s.name,
        color: s.color,
        position: s.position,
      }));
      await supabase.from('pipeline_stages').insert(stagesPayload);

      return pipeline as Pipeline;
    }, [supabase, accountId, t, defaultStages]);

  const refreshPipelines = useCallback(async () => {
    if (!accountId) return;
    await queryClient.invalidateQueries({ queryKey: qk.pipelines(accountId) });
  }, [queryClient, accountId]);

  const refreshStages = useCallback(async () => {
    if (!accountId || !selectedPipelineId) return;
    await queryClient.invalidateQueries({ queryKey: qk.stages(accountId, selectedPipelineId) });
  }, [queryClient, accountId, selectedPipelineId]);

  // Seed a default pipeline on a confirmed-empty account only — never on a
  // failed read (a transient error used to read as "first run" and insert
  // a duplicate "Default Pipeline" each time it happened).
  const confirmedEmpty = pipelinesQuery.isSuccess && pipelines.length === 0;
  useEffect(() => {
    if (!confirmedEmpty || seedAttempted.current) return;
    seedAttempted.current = true;
    void (async () => {
      setSeeding(true);
      await seedDefaultPipeline();
      await refreshPipelines();
      setSeeding(false);
    })();
  }, [confirmedEmpty, seedDefaultPipeline, refreshPipelines]);

  useEffect(() => {
    if (pipelinesQuery.isError) toast.error(t('toastFailedLoadPipelines'));
  }, [pipelinesQuery.isError, t]);

  const loading = pipelinesQuery.isPending || seeding;

  const handleDealMoved = useCallback(
    (dealId: string, newStageId: string, newPosition?: number) => {
      // Omitting position_in_stage on a same-stage move would let the DB
      // trigger's "stage changed" branch reassign it — pass it through
      // whenever the caller has it. The mutation updates the cache first
      // (the board already animated) and rolls back if RLS refuses.
      const patch: { stage_id: string; position_in_stage?: number } = { stage_id: newStageId };
      if (newPosition !== undefined) patch.position_in_stage = newPosition;
      updateDeal.mutate(
        { id: dealId, patch },
        { onError: () => toast.error(t('toastFailedMoveDeal')) }
      );
    },
    [updateDeal, t]
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setDefaultStageId(stageId ?? stages[0]?.id ?? '');
      setQuickOpen(true);
    },
    [stages]
  );

  const handleEditDeal = useCallback((deal: Deal) => {
    setOpenDealId(deal.id);
  }, []);

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setCreating(false);
      return;
    }
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) {
      toast.error(t('toastNotLinkedToAccount'));
      setCreating(false);
      return;
    }

    const { data: pipeline, error } = await supabase
      .from('pipelines')
      .insert({ user_id: user.id, account_id: accountId, name })
      .select()
      .single();

    if (error || !pipeline) {
      toast.error(t('toastFailedCreatePipeline'));
      setCreating(false);
      return;
    }

    const stagesPayload = defaultStages.map((s) => ({
      pipeline_id: pipeline.id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));
    await supabase.from('pipeline_stages').insert(stagesPayload);

    setNewPipelineName('');
    setNewPipelineOpen(false);
    setSelectedPipelineId(pipeline.id);
    await refreshPipelines();
    setCreating(false);
    toast.success(t('toastPipelineCreated'));
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48 rounded-full" />
          <Skeleton className="h-9 w-28 rounded-full" />
        </div>
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-96 w-72 shrink-0 rounded-[22px]" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Pipeline selector dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger className="border-border bg-card text-foreground hover:bg-muted data-[popup-open]:bg-muted inline-flex min-h-10 items-center gap-2 rounded-full border px-4 text-sm transition-colors duration-150 ease-out">
              <GitBranch className="text-primary h-4 w-4" />
              <span className="font-semibold">
                {selectedPipeline?.name ?? t('selectPipeline')}
              </span>
              <ChevronDown className="text-muted-foreground h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover text-popover-foreground w-64"
            >
              {pipelines.length === 0 && (
                <DropdownMenuItem disabled className="text-muted-foreground">
                  {t('noPipelinesYet')}
                </DropdownMenuItem>
              )}
              {pipelines.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => setSelectedPipelineId(p.id)}
                  className={
                    p.id === selectedPipelineId
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  }
                >
                  <GitBranch className="mr-2 h-3.5 w-3.5" />
                  {p.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="bg-border" />
              {selectedPipeline && canEditSettings && (
                <DropdownMenuItem
                  onClick={() => setSettingsOpen(true)}
                  className="text-popover-foreground"
                >
                  <Settings className="mr-2 h-3.5 w-3.5" />
                  {t('managePipelines')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2">
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="createPipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t('addPipeline')}
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason="createDeals"
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
            className="bg-foreground text-background hover:bg-foreground/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t('addDeal')}
          </GatedButton>
        </div>
      </div>

      {/* Board */}
      {pipelines.length === 0 ? (
        <div className="border-border flex flex-col items-center justify-center rounded-[24px] border border-dashed py-20">
          <GitBranch className="text-muted-foreground h-12 w-12" />
          <h3 className="text-foreground mt-4 text-lg font-medium">
            {t('noPipelinesYet')}
          </h3>
          <p className="text-muted-foreground mt-2 text-sm">
            {t('createToStartTracking')}
          </p>
          <GatedButton
            canAct={canEditSettings}
            gateReason="createPipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="bg-foreground text-background hover:bg-foreground/90 mt-4"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t('createPipeline')}
          </GatedButton>
        </div>
      ) : (
        <>
          <PipelineAnalytics stages={stages} deals={deals} />
          <PipelineBoard
            stages={stages}
            deals={deals}
            onDealMoved={handleDealMoved}
            onAddDeal={handleAddDeal}
            onEditDeal={handleEditDeal}
            selectedDealId={openDealId}
          />
        </>
      )}

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('newPipeline')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-muted-foreground">{t('pipelineName')}</Label>
            <Input
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder={t('pipelineNamePlaceholder')}
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreatePipeline();
              }}
            />
            <p className="text-muted-foreground mt-2 text-xs">
              {t('defaultStagesDesc')}
            </p>
          </div>
          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setNewPipelineOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
              className="bg-foreground text-background hover:bg-foreground/90"
            >
              {creating ? t('creating') : t('createPipelineBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {selectedPipeline && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={stages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshStages}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* Deal view (side card on desktop, bottom sheet on phones) */}
      <DealPanel
        deal={openDeal}
        stages={stages}
        pipelineId={selectedPipelineId}
        onClose={() => setOpenDealId(null)}
      />

      <DealQuickCreate
        open={quickOpen}
        onOpenChange={setQuickOpen}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onCreated={(id, openPanel) => {
          if (openPanel) setOpenDealId(id);
        }}
      />
    </div>
  );
}
