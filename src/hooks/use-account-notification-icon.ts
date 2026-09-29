'use client';

import { useAuth } from '@/hooks/use-auth';
import { accountNotificationIconUrl, brandingVersion } from '@/lib/pwa';

/**
 * Icon URL for notifications shown in this tab — the account's logo (or
 * its colored mark), same image the server puts on Web Push.
 */
export function useAccountNotificationIcon(): string {
  const { account } = useAuth();
  if (!account) return accountNotificationIconUrl(null);
  return accountNotificationIconUrl({
    accountId: account.id,
    version: brandingVersion([
      account.display_name,
      account.logo_url,
      account.brand_color,
    ]),
  });
}
