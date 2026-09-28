'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UsersRound, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InviteMemberDialog } from '@/components/settings/invite-member-dialog';
import { useOnboarding } from '../onboarding-context';
import { StepFooter } from '../step-footer';

/**
 * Last step, deliberately — the spec follows deskcomm's order
 * (invite after the agent has already demonstrated it works, not
 * before): "só faz sentido convidar alguém pra um sistema que já
 * demonstrou funcionar." Reuses the same invite dialog Settings →
 * Members uses, rather than a second implementation of invite-link
 * creation.
 */
export default function OnboardingTeamPage() {
  const t = useTranslations('Onboarding.team');
  const router = useRouter();
  const { markDone, markSkipped } = useOnboarding();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invited, setInvited] = useState(false);

  async function handleContinue() {
    await markDone('team', { invited });
    router.push('/onboarding');
  }

  async function handleSkip() {
    await markSkipped('team');
    router.push('/onboarding');
  }

  return (
    <div>
      <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-full">
        <UsersRound className="size-5" />
      </div>
      <h1 className="text-foreground mt-4 text-xl font-semibold">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="mt-6">
        <Button onClick={() => setInviteOpen(true)} variant="outline">
          <UserPlus className="size-4" />
          {t('inviteBtn')}
        </Button>
      </div>

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={() => setInvited(true)}
      />

      <StepFooter onContinue={handleContinue} onSkip={handleSkip} />
    </div>
  );
}
