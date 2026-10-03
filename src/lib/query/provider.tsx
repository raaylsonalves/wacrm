'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * One QueryClient per browser tab, created lazily so a server render never
 * shares a cache between requests. Defaults suit a CRM screen left open all
 * day: data counts as fresh for 30s (switching pages and back is instant),
 * refetches when the tab regains focus, and retries a failed read once.
 *
 * Reads still go straight to Supabase from the browser — RLS stays the
 * authorization layer; TanStack Query only owns caching, loading/error
 * state and optimistic writes.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 10 * 60_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
          mutations: { retry: 0 },
        },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
