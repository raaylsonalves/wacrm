'use client';

import { useTranslations } from 'next-intl';
import { Check, Loader2, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OnboardingProvider, useOnboarding } from './onboarding-context';
import { STEPS, isStepDone, isStepSkipped } from '@/lib/onboarding/steps';

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

function OnboardingShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('Onboarding');
  const { state, loading, skipOnboarding } = useOnboarding();

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
                <li
                  key={step.segment}
                  className={cn(
                    'flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
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
      <main className="mx-auto max-w-xl px-4 py-10">{children}</main>
    </div>
  );
}
