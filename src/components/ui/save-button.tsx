'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ButtonProps = React.ComponentProps<typeof Button>;

/**
 * Save button with the v2 feedback in place of a success toast: while
 * `saving` it shows a small spinner and "Salvando…"; each time `savedAt`
 * changes it flashes mint with "✓ Salvo" for ~1.8s, then returns to its
 * label. Pure CSS (keyed spans + keyframes in globals.css), so there's no
 * timer state to manage — set `savedAt = Date.now()` on success.
 */
export function SaveButton({
  saving,
  savedAt,
  children,
  className,
  disabled,
  ...props
}: ButtonProps & {
  saving: boolean;
  /** Timestamp of the last successful save; a new value replays the flash. */
  savedAt?: number | null;
}) {
  const t = useTranslations('Common.save');
  // A form usually disables its button once saved (nothing dirty); keep it
  // at full strength while the flash plays so the mint doesn't look faded.
  const [flashing, setFlashing] = useState(false);
  return (
    <Button
      {...props}
      disabled={disabled || saving}
      aria-busy={saving || undefined}
      className={cn(
        'relative overflow-hidden',
        flashing && 'disabled:opacity-100',
        className
      )}
    >
      {savedAt ? (
        <span
          key={`bg-${savedAt}`}
          aria-hidden
          className="save-flash-bg bg-tone-mint absolute inset-0"
        />
      ) : null}
      <span className="relative inline-grid place-items-center">
        <span
          key={`label-${savedAt ?? 0}`}
          className={cn(
            'col-start-1 row-start-1 inline-flex items-center gap-1.5',
            savedAt && !saving && 'save-flash-label'
          )}
        >
          {saving ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              {t('saving')}
            </>
          ) : (
            children
          )}
        </span>
        {savedAt && !saving ? (
          <span
            key={`done-${savedAt}`}
            aria-hidden
            onAnimationStart={() => setFlashing(true)}
            onAnimationEnd={() => setFlashing(false)}
            className="save-flash-done text-tone-on col-start-1 row-start-1 inline-flex items-center gap-1.5"
          >
            <Check className="size-4" />
            {t('saved')}
          </span>
        ) : null}
      </span>
      <span className="sr-only" aria-live="polite">
        {savedAt && !saving ? t('saved') : ''}
      </span>
    </Button>
  );
}
