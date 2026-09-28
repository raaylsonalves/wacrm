'use client';

import { useTranslations } from 'next-intl';
import { Check, PartyPopper, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useOnboarding } from '../onboarding-context';
import { STEPS, isStepDone } from '@/lib/onboarding/steps';

/**
 * A summary, not a generic "All set!" — specs/signup-onboarding-
 * wizard.md calls this out explicitly: name what got skipped and
 * where to finish it later, not just celebrate. `skipOnboarding` is
 * reused here (not a separate "finish" action) because by the time
 * the router lands on /done, every step already resolved to done or
 * skipped — skipAllRemaining is a no-op on that state (see
 * steps.test.ts) and onboarded_at still needs to be set either way.
 */
export default function OnboardingDonePage() {
  const t = useTranslations('Onboarding.done');
  const { state, skipOnboarding } = useOnboarding();

  const skippedSteps = STEPS.filter((s) => !isStepDone(state, s.segment));

  return (
    <div>
      <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-full">
        <PartyPopper className="size-5" />
      </div>
      <h1 className="text-foreground mt-4 text-xl font-semibold">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <ul className="mt-6 space-y-2">
        {STEPS.map((step) => {
          const done = isStepDone(state, step.segment);
          return (
            <li
              key={step.segment}
              className={cn(
                'border-border flex items-center gap-2 rounded-lg border p-3 text-sm',
                done ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {done ? (
                <Check className="text-primary size-4 shrink-0" />
              ) : (
                <X className="size-4 shrink-0" />
              )}
              {t(step.labelKey)}
            </li>
          );
        })}
      </ul>

      {skippedSteps.length > 0 && (
        <p className="text-muted-foreground mt-4 text-sm">
          {t('skippedNote', {
            steps: skippedSteps.map((s) => t(s.labelKey)).join(', '),
          })}
        </p>
      )}

      <Button
        onClick={() => void skipOnboarding('/inbox')}
        className="mt-6 w-full sm:w-auto"
      >
        {t('goToInboxBtn')}
      </Button>
    </div>
  );
}
