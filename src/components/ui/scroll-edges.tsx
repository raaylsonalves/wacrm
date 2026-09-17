'use client';

// ============================================================
// Shared "more content this way" affordance for horizontally-scrolling
// pill rows (tab bars, filter chips, the settings rail on mobile) —
// the YouTube-style category-chip pattern: a small arrow button over a
// fade at whichever edge still has hidden content, gone once you've
// scrolled all the way there. Without it, a scrollable pill row gives
// no visual hint that it scrolls at all — the exact bug this replaces
// (tabs silently clipped with no affordance to reach them).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Tracks whether a scrollable element has more content to the left/right,
 *  and exposes a ref to attach to it plus a helper to scroll by a page. */
export function useHorizontalScrollEdges<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [update]);

  const scrollByDir = useCallback(
    (dir: 1 | -1) => {
      const el = ref.current;
      if (!el) return;
      el.scrollBy({ left: dir * el.clientWidth * 0.6, behavior: 'smooth' });
      // The native `scroll` event covers organic drag/wheel scrolling, but
      // don't lean on it alone for this button-triggered path — a couple
      // of explicit re-checks across the smooth-scroll animation keep the
      // arrows in sync even if a `scroll` event gets coalesced/dropped.
      window.setTimeout(update, 150);
      window.setTimeout(update, 400);
    },
    [update]
  );

  return { ref, canLeft, canRight, scrollByDir, recompute: update };
}

/**
 * Absolutely-positioned fade + arrow pair for whichever edges
 * `useHorizontalScrollEdges` says still have hidden content. Render
 * inside a `relative` wrapper around the scrollable row.
 * `fadeFrom` must match the row's own background (e.g. `from-card`,
 * `from-popover`) so the fade blends instead of showing a seam.
 */
export function ScrollEdgeFades({
  canLeft,
  canRight,
  onLeft,
  onRight,
  fadeFrom = 'from-card',
  hiddenAbove,
}: {
  canLeft: boolean;
  canRight: boolean;
  onLeft: () => void;
  onRight: () => void;
  fadeFrom?: string;
  /** Breakpoint prefix (e.g. "lg") at/above which this affordance hides —
   *  for rails that switch to a non-scrolling vertical layout on desktop. */
  hiddenAbove?: string;
}) {
  const hideClass = hiddenAbove ? `${hiddenAbove}:hidden` : undefined;

  return (
    <>
      {canLeft && (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 z-10 flex w-9 items-center bg-gradient-to-r to-transparent',
            fadeFrom,
            hideClass
          )}
        >
          <button
            type="button"
            onClick={onLeft}
            aria-label="Scroll left"
            className="bg-background text-foreground ring-border pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full shadow ring-1"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {canRight && (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 z-10 flex w-9 items-center justify-end bg-gradient-to-l to-transparent',
            fadeFrom,
            hideClass
          )}
        >
          <button
            type="button"
            onClick={onRight}
            aria-label="Scroll right"
            className="bg-background text-foreground ring-border pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full shadow ring-1"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>
  );
}
