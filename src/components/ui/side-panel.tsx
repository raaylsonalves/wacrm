'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const DESKTOP = '(min-width: 1024px)';
function subscribeDesktop(cb: () => void) {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
const readDesktop = () => window.matchMedia(DESKTOP).matches;

/** Whether the viewport is lg+ (side card) rather than a phone (sheet). */
export function useIsDesktop() {
  return useSyncExternalStore(subscribeDesktop, readDesktop, () => true);
}

/**
 * v8 record view shell: a floating card beside the page on desktop (the
 * list stays visible and usable) and a bottom sheet with a grab handle on
 * phones. Esc closes on desktop; the sheet handles it on phones.
 */
export function SidePanel({
  open,
  onClose,
  label,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the panel. */
  label: string;
  /** Desktop card only — e.g. a top offset to clear a page's own toolbar. */
  className?: string;
  children: React.ReactNode;
}) {
  const isDesktop = useIsDesktop();

  useEffect(() => {
    if (!open || !isDesktop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isDesktop, onClose]);

  if (isDesktop) {
    if (!open) return null;
    return (
      <aside
        aria-label={label}
        className={cn(
          'bg-card border-border animate-enter fixed top-3 right-3 bottom-3 z-40 flex w-[440px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-[24px] border shadow-[0_24px_60px_rgb(0_0_0/0.14)]',
          className
        )}
      >
        {children}
      </aside>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="h-[88dvh] gap-0 p-0"
      >
        <SheetTitle className="sr-only">{label}</SheetTitle>
        <div className="flex justify-center pt-2.5 pb-1" aria-hidden>
          <span className="bg-border h-1.5 w-11 rounded-full" />
        </div>
        {open && children}
      </SheetContent>
    </Sheet>
  );
}

/** "Tudo salvo" at rest, "Salvando…" in flight, a "✓ Salvo" flash after. */
export function SaveState({
  pending,
  failed,
  savedAt,
}: {
  pending: boolean;
  failed: boolean;
  savedAt: number | null;
}) {
  const t = useTranslations('Common.save');
  if (failed)
    return (
      <span className="text-tone-pink-ink text-xs font-semibold">
        {t('failed')}
      </span>
    );
  if (pending)
    return (
      <span className="text-muted-foreground text-xs font-semibold">
        {t('saving')}
      </span>
    );
  return (
    <span
      className="relative inline-grid text-xs font-semibold"
      aria-live="polite"
    >
      <span
        key={`a-${savedAt ?? 0}`}
        className={cn(
          'text-muted-foreground col-start-1 row-start-1',
          savedAt && 'save-flash-label'
        )}
      >
        {t('allSaved')}
      </span>
      {savedAt && (
        <span
          key={`b-${savedAt}`}
          className="save-flash-done text-tone-mint-ink col-start-1 row-start-1"
        >
          ✓ {t('saved')}
        </span>
      )}
    </span>
  );
}
