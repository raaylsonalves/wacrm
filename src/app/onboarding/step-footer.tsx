'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

interface StepFooterProps {
  onContinue: () => void;
  onSkip: () => void;
  continueDisabled?: boolean;
  continueLabelKey?: string;
}

/** Shared footer for every /onboarding/<segment> page — "Skip for
 *  now" always available (specs/signup-onboarding-wizard.md's
 *  per-step skip, distinct from the layout's "skip onboarding
 *  entirely" link), "Continue" gated per-step via `continueDisabled`
 *  (e.g. the "test" step requires a real reply first). */
export function StepFooter({
  onContinue,
  onSkip,
  continueDisabled = false,
  continueLabelKey = 'continueBtn',
}: StepFooterProps) {
  const t = useTranslations('Onboarding');
  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      <Button
        variant="ghost"
        onClick={onSkip}
        className="text-muted-foreground"
      >
        {t('skipStepBtn')}
      </Button>
      <Button onClick={onContinue} disabled={continueDisabled}>
        {t(continueLabelKey)}
        <ArrowRight className="ml-1.5 size-4" />
      </Button>
    </div>
  );
}
