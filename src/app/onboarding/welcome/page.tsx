'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Building2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useOnboarding } from '../onboarding-context';
import { StepFooter } from '../step-footer';

/**
 * First step: the business name shown across the app
 * (accounts.display_name — same column Settings → Branding edits;
 * see specs/account-branding.md). Timezone was in the spec's original
 * draft, but there's no timezone column/concept anywhere in the
 * schema today (only NEXT_PUBLIC_APP_LOCALE, which is language, not
 * timezone) — adding one just for this step would be inventing a
 * feature this spec didn't ask for. Dropped; note left in
 * docs/status-melhorias-deskcomm.md.
 */
export default function OnboardingWelcomePage() {
  const t = useTranslations('Onboarding.welcome');
  const router = useRouter();
  const { accountId, displayName, markDone, markSkipped } = useOnboarding();
  const [name, setName] = useState(displayName);
  const [saving, setSaving] = useState(false);

  async function handleContinue() {
    if (!accountId) return;
    const trimmed = name.trim();
    setSaving(true);
    try {
      if (trimmed) {
        const supabase = createClient();
        const { error } = await supabase
          .from('accounts')
          .update({ display_name: trimmed })
          .eq('id', accountId);
        if (error) throw error;
      }
      await markDone('welcome', { display_name: trimmed });
      router.push('/onboarding');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleSkip() {
    await markSkipped('welcome');
    router.push('/onboarding');
  }

  return (
    <div>
      <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-full">
        <Building2 className="size-5" />
      </div>
      <h1 className="text-foreground mt-4 text-xl font-semibold">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="mt-6 space-y-1.5">
        <Label>{t('nameField')}</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('namePlaceholder')}
          autoFocus
        />
      </div>

      <StepFooter
        onContinue={handleContinue}
        onSkip={handleSkip}
        continueDisabled={saving}
      />
    </div>
  );
}
