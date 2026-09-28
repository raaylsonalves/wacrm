'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Radio } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { WahaChannels } from '@/components/settings/waha-channels';
import { useOnboarding } from '../onboarding-context';
import { StepFooter } from '../step-footer';

/**
 * Same connection screens Settings → WhatsApp uses (Cloud API tab +
 * WAHA QR/pairing-code tab, specs/waha-channel-connection.md) —
 * embedded here instead of duplicated, so a fix to either component
 * doesn't need to land twice. Not a decorative mockup: this connects
 * a real number.
 */
export default function OnboardingChannelPage() {
  const t = useTranslations('Onboarding.channel');
  const router = useRouter();
  const { markDone, markSkipped } = useOnboarding();

  async function handleContinue() {
    await markDone('channel');
    router.push('/onboarding');
  }

  async function handleSkip() {
    await markSkipped('channel');
    router.push('/onboarding');
  }

  return (
    <div>
      <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-full">
        <Radio className="size-5" />
      </div>
      <h1 className="text-foreground mt-4 text-xl font-semibold">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="border-border bg-muted/30 text-muted-foreground mt-6 flex items-start gap-2 rounded-lg border p-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <p>{t('conflictWarning')}</p>
      </div>

      <Tabs defaultValue="cloud-api" className="mt-4">
        <TabsList>
          <TabsTrigger value="cloud-api">{t('cloudApiTab')}</TabsTrigger>
          <TabsTrigger value="qr">{t('qrTab')}</TabsTrigger>
        </TabsList>
        <TabsContent value="cloud-api">
          <WhatsAppConfig />
        </TabsContent>
        <TabsContent value="qr">
          <WahaChannels />
        </TabsContent>
      </Tabs>

      <StepFooter onContinue={handleContinue} onSkip={handleSkip} />
    </div>
  );
}
