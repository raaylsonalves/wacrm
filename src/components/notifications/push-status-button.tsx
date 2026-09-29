'use client';

import { BellOff, BellRing } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { shouldNudgePush, usePushControl } from '@/hooks/use-push-control';
import { PushControlPanel } from './push-control-panel';

/**
 * Header shortcut to this device's push notifications — the Settings
 * toggle alone was too buried for something every agent needs on day
 * one. Off → a bell-off icon with an amber dot; on → a quiet bell.
 *
 * Distinct icon from the sidebar's Notifications bell (the in-app
 * notification center) on purpose: this one is "alerts on this device".
 * Hidden entirely where push can't work (unsupported browser, or a
 * deployment without VAPID keys), so it never nags about the unfixable.
 */
export function PushStatusButton() {
  const t = useTranslations('Header.push');
  const control = usePushControl();

  if (control.configured !== true) return null;
  if (control.support === null || control.support === 'unsupported') {
    return null;
  }

  const nudge = shouldNudgePush(control);
  const label = control.subscribed ? t('labelOn') : t('labelOff');

  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className={cn(
          'hover:bg-muted hover:text-foreground data-popup-open:bg-muted relative flex h-10 w-10 items-center justify-center rounded-md transition-colors',
          nudge ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {control.subscribed ? (
          <BellRing className="h-5 w-5" />
        ) : (
          <BellOff className="h-5 w-5" />
        )}
        {nudge && (
          <span className="absolute top-2 right-2 flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
            <span className="ring-background relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500 ring-2" />
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-3">
        <div className="space-y-1">
          <p className="text-foreground text-sm font-semibold">{t('title')}</p>
          <p className="text-muted-foreground text-xs">
            {control.subscribed ? t('descriptionOn') : t('descriptionOff')}
          </p>
        </div>
        <PushControlPanel control={control} />
      </PopoverContent>
    </Popover>
  );
}
