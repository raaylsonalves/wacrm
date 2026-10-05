'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { qk } from '@/lib/query/keys';
import type { Deal, Pipeline, PipelineStage } from '@/types';

// Reads rely on RLS for account scoping (the browser client carries the
// user's session); the account id is only part of the cache key.

export function usePipelines() {
  const { accountId } = useAuth();
  return useQuery({
    queryKey: qk.pipelines(accountId ?? ''),
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('pipelines')
        .select('*')
        .order('created_at');
      if (error) throw error;
      return (data ?? []) as Pipeline[];
    },
  });
}

export function useStages(pipelineId: string) {
  const { accountId } = useAuth();
  return useQuery({
    queryKey: qk.stages(accountId ?? '', pipelineId),
    enabled: !!accountId && !!pipelineId,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('pipeline_stages')
        .select('*')
        .eq('pipeline_id', pipelineId)
        .order('position');
      if (error) throw error;
      return (data ?? []) as PipelineStage[];
    },
  });
}

export function useDeals(pipelineId: string) {
  const { accountId } = useAuth();
  return useQuery({
    queryKey: qk.deals(accountId ?? '', pipelineId),
    enabled: !!accountId && !!pipelineId,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('deals')
        .select(
          '*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)'
        )
        .eq('pipeline_id', pipelineId)
        .order('position_in_stage', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Deal[];
    },
  });
}

/** Columns a deal view may write. Nullable ones clear with null. */
export interface DealPatch {
  title?: string;
  value?: number;
  currency?: string;
  stage_id?: string;
  position_in_stage?: number | null;
  status?: Deal['status'];
  expected_close_date?: string | null;
  notes?: string | null;
  assigned_to?: string | null;
  contact_id?: string;
}

/**
 * Write a few fields of one deal with an optimistic update: the board and
 * any open deal view change at once, roll back if the write fails, and the
 * list is re-read afterwards so DB-side changes (position triggers,
 * won/lost timestamps) land too.
 *
 * RLS silently drops an UPDATE it filters out — PostgREST answers 200 with
 * zero rows — so `.select('id')` turns that into an error the caller sees.
 */
export function useUpdateDeal(pipelineId: string) {
  const { accountId } = useAuth();
  const queryClient = useQueryClient();
  const key = qk.deals(accountId ?? '', pipelineId);

  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: DealPatch }) => {
      const { data, error } = await createClient()
        .from('deals')
        .update(patch)
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('not_allowed');
    },
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Deal[]>(key);
      queryClient.setQueryData<Deal[]>(key, (old) =>
        old?.map((d) => (d.id === id ? ({ ...d, ...patch } as Deal) : d))
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(key, ctx.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

/**
 * Keep a pipeline's board live: a colleague's create/move/edit (or an
 * automation's) refetches the deals. Debounced so a burst of writes — a
 * drag reorders several cards — costs one refetch, and skipped while a
 * local edit is in flight so the optimistic card doesn't jump back.
 */
export function useDealsRealtime(pipelineId: string) {
  const { accountId } = useAuth();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!accountId || !pipelineId) return;
    const key = qk.deals(accountId, pipelineId);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (queryClient.isMutating() > 0) return refresh();
        void queryClient.invalidateQueries({ queryKey: key });
      }, 400);
    };
    const supabase = createClient();
    const channel = supabase
      .channel(`deals:${pipelineId}:${crypto.randomUUID()}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'deals',
          filter: `pipeline_id=eq.${pipelineId}`,
        },
        refresh
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [accountId, pipelineId, queryClient]);
}

export interface DealEvent {
  id: string;
  deal_id: string;
  actor_user_id: string | null;
  kind:
    'created' | 'stage' | 'value' | 'owner' | 'status' | 'title' | 'close_date';
  from_value: unknown;
  to_value: unknown;
  created_at: string;
}

/** A deal's history, newest first, live while the deal view is open. */
export function useDealEvents(dealId: string | null) {
  const { accountId } = useAuth();
  const queryClient = useQueryClient();
  const key = qk.dealEvents(accountId ?? '', dealId ?? '');
  useEffect(() => {
    if (!accountId || !dealId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`deal-events:${dealId}:${crypto.randomUUID()}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'deal_events',
          filter: `deal_id=eq.${dealId}`,
        },
        () =>
          void queryClient.invalidateQueries({
            queryKey: qk.dealEvents(accountId, dealId),
          })
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [accountId, dealId, queryClient]);
  return useQuery({
    queryKey: key,
    enabled: !!accountId && !!dealId,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('deal_events')
        .select('*')
        .eq('deal_id', dealId!)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as DealEvent[];
    },
  });
}
