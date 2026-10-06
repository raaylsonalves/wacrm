'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Bot } from 'lucide-react';
import { AiConfig } from '@/components/settings/ai-config';
import { buildPromptContext, sanitizeProfile } from '@/lib/onboarding/profile';
import { useOnboarding } from '../onboarding-context';
import { StepFooter } from '../step-footer';

/** Same form as Settings → AI Assistant / /agents → Setup — BYO
 *  provider key, model, system prompt. */
export default function OnboardingAiAgentPage() {
  const t = useTranslations('Onboarding.aiAgent');
  const router = useRouter();
  const tp = useTranslations('Onboarding.profile');
  const locale = useLocale();
  const { state, displayName, markDone, markSkipped } = useOnboarding();

  // Starts the assistant's business context from the company profile
  // answered earlier (empty when that step was skipped).
  const initialPrompt = buildPromptContext(
    sanitizeProfile(state.profile?.profile),
    displayName,
    {
      business: (name) => tp('prompt.business', { name }),
      segment: (value) => tp('prompt.segment', { value }),
      goals: (value) => tp('prompt.goals', { value }),
      tone: (value) => tp('prompt.tone', { value }),
      about: (value) => tp('prompt.about', { value }),
      hours: (value) => tp('prompt.hours', { value }),
      allDay: () => tp('prompt.allDay'),
      dayLabel: (d) =>
        new Date(2024, 0, 7 + d).toLocaleDateString(locale, {
          weekday: 'short',
        }),
      segmentLabel: (v) => tp(`segment.${v}`),
      goalLabel: (v) => tp(`goal.${v}`),
      toneLabel: (v) => tp(`tone.${v}`),
    }
  );

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
        <AiConfig initialPrompt={initialPrompt || undefined} />
      </div>

      <StepFooter onContinue={handleContinue} onSkip={handleSkip} />
    </div>
  );
}
