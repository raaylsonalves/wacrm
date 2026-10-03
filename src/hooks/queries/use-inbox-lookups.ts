'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { Profile, Tag } from '@/types';

/*
 * Slow-changing lookups the inbox reads in several places. Conversations
 * and messages stay on the page's realtime-driven state (see inbox/page.tsx
 * for why); only these reference lists go through the cache, so the list,
 * the thread and the notes share one request instead of one each.
 */

const LOOKUP_STALE = 5 * 60_000;

/** Teammates, full rows — assign menus and note authors. */
export function useTeamProfiles() {
  const { accountId } = useAuth();
  return useQuery({
    queryKey: ['team-profiles', accountId ?? ''],
    enabled: !!accountId,
    staleTime: LOOKUP_STALE,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('profiles')
        .select('*')
        .order('full_name');
      if (error) throw error;
      return (data ?? []) as Profile[];
    },
  });
}

/** Account tag definitions, for filter pickers. */
export function useTagDefinitions() {
  const { accountId } = useAuth();
  return useQuery({
    queryKey: ['tags', accountId ?? ''],
    enabled: !!accountId,
    staleTime: LOOKUP_STALE,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('tags')
        .select('*')
        .order('name');
      if (error) throw error;
      return (data ?? []) as Tag[];
    },
  });
}

export interface WahaChannelOption {
  id: string;
  label: string;
}

/** WAHA channels (id + label); empty for Cloud-API-only accounts. */
export function useWahaChannelOptions() {
  const { accountId } = useAuth();
  return useQuery({
    queryKey: ['waha-channels', accountId ?? ''],
    enabled: !!accountId,
    staleTime: LOOKUP_STALE,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('whatsapp_waha_channels')
        .select('id, label')
        .order('label');
      if (error) throw error;
      return (data ?? []) as WahaChannelOption[];
    },
  });
}

/** Whether an AI auto-reply is active on the account. Undefined while loading. */
export function useAiAutoReplyOn() {
  const { accountId } = useAuth();
  return useQuery({
    queryKey: ['ai-auto-reply-on', accountId ?? ''],
    enabled: !!accountId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('ai_configs')
        .select('id')
        .eq('account_id', accountId!)
        .eq('is_active', true)
        .eq('auto_reply_enabled', true)
        .limit(1);
      if (error) throw error;
      return (data ?? []).length > 0;
    },
  }).data;
}
