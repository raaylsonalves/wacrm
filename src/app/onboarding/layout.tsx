'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, Loader2, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OnboardingProvider, useOnboarding } from './onboarding-context';
import {
  STEPS,
  isStepDone,
  isStepSkipped,
  reachableSegments,
} from '@/lib/onboarding/steps';

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <OnboardingProvider>
      <OnboardingShell>{children}</OnboardingShell>
    </OnboardingProvider>
  );
}

const WIDE_STEPS = ['channel', 'ai-agent'];

function OnboardingShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('Onboarding');
  const { state, loading, skipOnboarding } = useOnboarding();
  const pathname = usePathname();
  const router = useRouter();
  const reachable = reachableSegments(state);
  const stepSegment = STEPS.find((st) =>
    pathname.startsWith(`/onboarding/${st.segment}`)
  )?.segment;
  const locked = !loading && !!stepSegment && !reachable.includes(stepSegment);

  // Typing a later step's URL must not skip the ones before it.
  useEffect(() => {
    if (locked) router.replace('/onboarding');
  }, [locked, router]);

  if (loading) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="bg-background min-h-screen">
      <header className="border-border flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-lg">
            <MessageSquare className="size-4" />
          </div>
          <ol className="flex flex-wrap items-center gap-1.5">
            {STEPS.map((step) => {
              const done = isStepDone(state, step.segment);
              const skipped = isStepSkipped(state, step.segment);
              return (
                <li key={step.segment}>
                  {/* Every step stays reachable, so a wrong answer can be
                      fixed without finishing the wizard first. */}
                  {reachable.includes(step.segment) ? (
                    <Link
                      href={`/onboarding/${step.segment}`}
                      aria-current={
                        pathname === `/onboarding/${step.segment}`
                          ? 'step'
                          : undefined
                      }
                      className={cn(
                        'hover:bg-muted flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition-colors',
                        pathname === `/onboarding/${step.segment}` &&
                          'ring-primary/40 ring-1',
                        done
                          ? 'bg-primary/10 text-primary'
                          : skipped
                            ? 'bg-muted text-muted-foreground'
                            : 'text-muted-foreground/70'
                      )}
                    >
                      {done && <Check className="size-3" />}
                      {skipped && <X className="size-3" />}
                      {t(step.labelKey)}
                    </Link>
                  ) : (
                    <span
                      aria-disabled="true"
                      className="text-muted-foreground/50 flex cursor-not-allowed items-center gap-1 rounded-full px-2 py-1 text-xs font-medium"
                    >
                      {t(step.labelKey)}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
        <button
          type="button"
          onClick={() => void skipOnboarding()}
          className="text-muted-foreground hover:text-foreground self-start text-xs underline sm:self-auto"
        >
          {t('skipOnboarding')}
        </button>
      </header>
      <main
        className={cn(
          'mx-auto px-4 py-10',
          // Steps that embed full settings screens need room; the short
          // questionnaire steps read better narrow.
          WIDE_STEPS.some((seg) => pathname === `/onboarding/${seg}`)
            ? 'max-w-5xl'
            : 'max-w-xl'
        )}
      >
        {children}
      </main>
    </div>
  );
}
