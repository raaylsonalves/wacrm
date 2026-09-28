'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import {
  markStepDone,
  markStepSkipped,
  skipAllRemaining,
  type OnboardingState,
} from '@/lib/onboarding/steps';

interface OnboardingCtxValue {
  accountId: string | null;
  displayName: string;
  state: OnboardingState;
  /** True while the initial account/state fetch is in flight. Every
   *  page under /onboarding should render nothing (or a spinner)
   *  until this clears, to avoid a step flashing before the redirect
   *  to /dashboard (already-onboarded) or another step (resuming
   *  mid-wizard) lands. */
  loading: boolean;
  markDone: (segment: string, extra?: Record<string, unknown>) => Promise<void>;
  markSkipped: (segment: string) => Promise<void>;
  /** `redirectTo` defaults to /dashboard (the always-visible "skip
   *  onboarding" link's destination); the done page's "Go to Inbox"
   *  button passes '/inbox' instead — same persistence, different
   *  landing spot. */
  skipOnboarding: (redirectTo?: string) => Promise<void>;
}

const OnboardingContext = createContext<OnboardingCtxValue | null>(null);

export function OnboardingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [state, setState] = useState<OnboardingState>({});
  const [loading, setLoading] = useState(true);
  // StrictMode/fast-refresh double-invokes effects in dev; this guards
  // against firing the redirect-if-onboarded check twice.
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        setLoading(false);
        router.replace('/login');
        return;
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('account_id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!profile?.account_id) {
        setLoading(false);
        return;
      }

      const { data: account } = await supabase
        .from('accounts')
        .select('name, display_name, onboarding_state, onboarded_at')
        .eq('id', profile.account_id)
        .maybeSingle();

      // Already onboarded (existing account, or finished a previous
      // session) — the wizard never shows again, even if some
      // individual step was never marked done (spec's acceptance
      // criterion: skipping everything still counts as onboarded).
      if (account?.onboarded_at) {
        router.replace('/dashboard');
        return;
      }

      setAccountId(profile.account_id);
      setDisplayName(account?.display_name || account?.name || '');
      setState((account?.onboarding_state as OnboardingState) ?? {});
      setLoading(false);
    })();
  }, [router]);

  const persist = useCallback(
    async (nextState: OnboardingState, onboardedAt?: string) => {
      setState(nextState);
      if (!accountId) return;
      const payload: Record<string, unknown> = {
        onboarding_state: nextState,
      };
      if (onboardedAt) payload.onboarded_at = onboardedAt;
      const supabase = createClient();
      const { error } = await supabase
        .from('accounts')
        .update(payload)
        .eq('id', accountId);
      if (error) {
        // Best-effort persistence — a failed write shouldn't trap the
        // user on this step. The in-memory state above already
        // advanced, so the wizard still moves forward; worst case, a
        // reload resets to the last successfully saved step.
        console.error('[onboarding] failed to save state:', error.message);
      }
    },
    [accountId]
  );

  const markDone = useCallback(
    async (segment: string, extra: Record<string, unknown> = {}) => {
      await persist(markStepDone(state, segment, extra));
    },
    [state, persist]
  );

  const markSkipped = useCallback(
    async (segment: string) => {
      await persist(markStepSkipped(state, segment));
    },
    [state, persist]
  );

  const skipOnboarding = useCallback(
    async (redirectTo = '/dashboard') => {
      await persist(skipAllRemaining(state), new Date().toISOString());
      router.replace(redirectTo);
    },
    [state, persist, router]
  );

  return (
    <OnboardingContext.Provider
      value={{
        accountId,
        displayName,
        state,
        loading,
        markDone,
        markSkipped,
        skipOnboarding,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingCtxValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error('useOnboarding must be used within OnboardingProvider');
  }
  return ctx;
}
