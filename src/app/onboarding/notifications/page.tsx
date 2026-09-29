'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BellRing, CircleAlert } from 'lucide-react';

import { PushControlPanel } from '@/components/notifications/push-control-panel';
import { usePushControl } from '@/hooks/use-push-control';
import { useOnboarding } from '../onboarding-context';
import { StepFooter } from '../step-footer';

/**
 * Turn on push for the device doing onboarding. The onboarding state is
 * per account while push is per device — this covers the person setting
 * the account up; teammates get the header icon and the inbox banner.
 *
 * Nothing here opens the browser prompt by itself: the explanation comes
 * first, and the prompt only follows the user's own click on the switch.
 */
export default function OnboardingNotificationsPage() {
  const t = useTranslations('Onboarding.notifications');
  const router = useRouter();
  const { markDone, markSkipped } = useOnboarding();
  const control = usePushControl();

  async function handleContinue() {
    await markDone('notifications', { enabled: control.subscribed });
    router.push('/onboarding');
  }

  async function handleSkip() {
    await markSkipped('notifications');
    router.push('/onboarding');
  }

  return (
    <div>
      <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-full">
        <BellRing className="size-5" />
      </div>
      <h1 className="text-foreground mt-4 text-xl font-semibold">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="mt-6">
        {control.configured === false ? (
          <p className="text-muted-foreground flex items-start gap-2 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {t('notConfigured')}
          </p>
        ) : (
          <PushControlPanel control={control} />
        )}
      </div>

      <StepFooter onContinue={handleContinue} onSkip={handleSkip} />
    </div>
  );
}
