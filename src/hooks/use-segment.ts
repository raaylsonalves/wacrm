'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { isSegment, profileFor, type Segment, type SegmentProfile } from '@/lib/segments/profiles';

export const segmentQueryKey = (accountId: string) => ['account-segment', accountId];

/** The account's segment (migration 135) and its profile. */
export function useSegment(): { segment: Segment | null; profile: SegmentProfile; loading: boolean } {
  const { accountId } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: segmentQueryKey(accountId ?? ''),
    enabled: !!accountId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await createClient().from('accounts').select('segment').eq('id', accountId!).maybeSingle();
      return isSegment(data?.segment) ? data.segment : null;
    },
  });
  const segment = data ?? null;
  return { segment, profile: profileFor(segment), loading: isLoading };
}
