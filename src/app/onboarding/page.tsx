'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useOnboarding } from './onboarding-context';
import { nextStep } from '@/lib/onboarding/steps';

/**
 * Resolves the next incomplete step and redirects there — mirrors the
 * deskcomm router (specs/signup-onboarding-wizard.md). The layout
 * above already redirects to /dashboard for an already-onboarded
 * account, so by the time this runs there's always a step to land on
 * (or none left, which means /done).
 */
export default function OnboardingIndexPage() {
  const router = useRouter();
  const { state, loading } = useOnboarding();

  useEffect(() => {
    if (loading) return;
    const step = nextStep(state);
    router.replace(step ? `/onboarding/${step.segment}` : '/onboarding/done');
  }, [loading, state, router]);

  return null;
}
