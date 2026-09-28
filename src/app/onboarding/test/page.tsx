'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { AiPlayground } from '@/components/agents/ai-playground';
import { useOnboarding } from '../onboarding-context';
import { StepFooter } from '../step-footer';

/**
 * "See it work before you finish setting it up" (the deskcomm lesson
 * quoted in the spec). Reuses the Playground — a real call to the
 * configured provider, not a canned demo — rather than sending an
 * actual WhatsApp message to the user's own number: that would
 * require the channel from the previous step to already be
 * `connected`/`WORKING`, which isn't guaranteed (Cloud API numbers
 * need Meta verification, WAHA sessions need a QR scan) — exactly the
 * fallback the spec's own risks section flags. "Continue" stays
 * disabled until a real reply lands, or the user skips explicitly.
 */
export default function OnboardingTestPage() {
  const t = useTranslations('Onboarding.test');
  const router = useRouter();
  const { markDone, markSkipped } = useOnboarding();
  const [replyReceived, setReplyReceived] = useState(false);

  const handleReplyReceived = useCallback(() => setReplyReceived(true), []);

  async function handleContinue() {
    if (!replyReceived) return;
    await markDone('test');
    router.push('/onboarding');
  }

  async function handleSkip() {
    await markSkipped('test');
    router.push('/onboarding');
  }

  return (
    <div>
      <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-full">
        <Sparkles className="size-5" />
      </div>
      <h1 className="text-foreground mt-4 text-xl font-semibold">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="mt-6">
        <AiPlayground onReplyReceived={handleReplyReceived} />
      </div>

      <StepFooter
        onContinue={handleContinue}
        onSkip={handleSkip}
        continueDisabled={!replyReceived}
      />
    </div>
  );
}
