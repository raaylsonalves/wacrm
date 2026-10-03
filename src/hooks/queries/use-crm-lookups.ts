'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';

export interface ContactLite {
  id: string;
  name: string | null;
  phone: string;
}

export interface ProfileLite {
  user_id: string;
  full_name: string | null;
}

/** Contacts for pickers (name + phone only), cached for the session. */
export function useContactsLite(enabled = true) {
  const { accountId } = useAuth();
  return useQuery({
    queryKey: ['contacts-lite', accountId ?? ''],
    enabled: enabled && !!accountId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('contacts')
        .select('id, name, phone')
        .order('name')
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as ContactLite[];
    },
  });
}

/** Teammates for "assigned to" pickers. */
export function useProfilesLite(enabled = true) {
  const { accountId } = useAuth();
  return useQuery({
    queryKey: ['profiles-lite', accountId ?? ''],
    enabled: enabled && !!accountId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('profiles')
        .select('user_id, full_name')
        .order('full_name');
      if (error) throw error;
      return (data ?? []) as ProfileLite[];
    },
  });
}

/** The contact's most recent conversation, for "Abrir conversa". */
export function useLatestConversationId(contactId: string | null | undefined) {
  const { accountId } = useAuth();
  return useQuery({
    queryKey: ['latest-conversation', accountId ?? '', contactId ?? ''],
    enabled: !!accountId && !!contactId,
    queryFn: async () => {
      const { data } = await createClient()
        .from('conversations')
        .select('id')
        .eq('contact_id', contactId!)
        .order('last_message_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data as { id: string } | null)?.id ?? null;
    },
  });
}
