'use client';

import { PushControlPanel } from '@/components/notifications/push-control-panel';
import { usePushControl } from '@/hooks/use-push-control';

/**
 * Web Push section of Settings → Profile → notifications card
 * (specs/pwa-web-push-notifications.md). Same control the header icon
 * and the onboarding step use.
 */
export function PushNotificationsSection() {
  const control = usePushControl();
  if (control.support === null) return null;
  return (
    <div className="border-border border-t pt-4">
      <PushControlPanel control={control} />
    </div>
  );
}
