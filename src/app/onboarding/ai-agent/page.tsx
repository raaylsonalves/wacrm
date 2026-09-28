'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bot } from 'lucide-react';
import { AiConfig } from '@/components/settings/ai-config';
import { useOnboarding } from '../onboarding-context';
import { StepFooter } from '../step-footer';

/** Same form as Settings → AI Assistant / /agents → Setup — BYO
 *  provider key, model, system prompt. */
export default function OnboardingAiAgentPage() {
  const t = useTranslations('Onboarding.aiAgent');
  const router = useRouter();
  const { markDone, markSkipped } = useOnboarding();

  async function handleContinue() {
    await markDone('ai-agent');
    router.push('/onboarding');
  }

  async function handleSkip() {
    await markSkipped('ai-agent');
    router.push('/onboarding');
  }

  return (
    <div>
      <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-full">
        <Bot className="size-5" />
      </div>
      <h1 className="text-foreground mt-4 text-xl font-semibold">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="mt-6">
        <AiConfig />
      </div>

      <StepFooter onContinue={handleContinue} onSkip={handleSkip} />
    </div>
  );
}
