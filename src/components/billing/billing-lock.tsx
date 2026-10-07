'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * A cancelled account keeps its dashboard, but the only screen it can use
 * is Settings > Billing (to subscribe again). Every other page is replaced
 * by this notice. It is a UI gate only; the API answers 402 on its own.
 */
export function BillingLock({
  locked,
  children,
}: {
  locked: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations('Settings.billing.locked');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const onSettings = pathname.startsWith('/settings');
  const onBilling = onSettings && searchParams.get('tab') === 'billing';

  useEffect(() => {
    if (locked && onSettings && !onBilling) {
      router.replace('/settings?tab=billing');
    }
  }, [locked, onSettings, onBilling, router]);

  if (!locked || onBilling) return <>{children}</>;
  if (onSettings) return null;

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
      <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">
        <Lock className="size-5" />
      </div>
      <h1 className="text-foreground text-lg font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <Link href="/settings?tab=billing" className="mt-2">
        <Button>{t('action')}</Button>
      </Link>
    </div>
  );
}
