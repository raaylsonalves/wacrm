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
  // A callback ref, so listeners attach whenever the row actually mounts —
  // inside a panel that first shows a spinner, a mount-time effect would
  // run against null and never wire up.
  const [el, setEl] = useState<T | null>(null);
  const elRef = useRef<T | null>(null);
  const ref = useCallback((node: T | null) => {
    elRef.current = node;
    setEl(node);
  }, []);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    // Hint that the row can be dragged (mouse only — touch already swipes).
    el.style.cursor = el.scrollWidth > el.clientWidth + 4 ? 'grab' : '';
  }, []);

  useEffect(() => {
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);

    // Press-and-drag to scroll with a mouse, like a phone swipe. A drag
    // past a few pixels swallows the click that ends it, so letting go
    // over a chip doesn't also select it.
    let down = false;
    let moved = false;
    let startX = 0;
    let startLeft = 0;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (el.scrollWidth <= el.clientWidth + 4) return;
      down = true;
      moved = false;
      startX = e.clientX;
      startLeft = el.scrollLeft;
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < 5) return;
      if (!moved) {
        moved = true;
        el.style.cursor = 'grabbing';
        el.style.userSelect = 'none';
      }
      el.scrollLeft = startLeft - dx;
    };
    const onUp = () => {
      if (!down) return;
      down = false;
      el.style.userSelect = '';
      update();
    };
    const onClick = (e: MouseEvent) => {
      if (!moved) return;
      moved = false;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('click', onClick, true);
    const onDragStart = (e: DragEvent) => {
      if (down) e.preventDefault();
    };
    el.addEventListener('dragstart', onDragStart);

    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      window.removeEventListener('resize', update);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('dragstart', onDragStart);
    };
  }, [el, update]);

  const scrollByDir = useCallback(
    (dir: 1 | -1) => {
      const el = elRef.current;
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
            'pointer-events-none absolute inset-y-0 left-0 z-10 flex w-14 items-center bg-gradient-to-r from-40% to-transparent',
            fadeFrom,
            hideClass
          )}
        >
          <button
            type="button"
            onClick={onLeft}
            aria-label="Scroll left"
            className="bg-card text-foreground border-border hover:bg-muted pointer-events-auto flex size-7 items-center justify-center rounded-full border shadow-[0_2px_8px_rgb(0_0_0/0.08)] transition-colors duration-150 ease-out"
          >
            <ChevronLeft className="size-4" />
          </button>
        </div>
      )}
      {canRight && (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 z-10 flex w-14 items-center justify-end bg-gradient-to-l from-40% to-transparent',
            fadeFrom,
            hideClass
          )}
        >
          <button
            type="button"
            onClick={onRight}
            aria-label="Scroll right"
            className="bg-card text-foreground border-border hover:bg-muted pointer-events-auto flex size-7 items-center justify-center rounded-full border shadow-[0_2px_8px_rgb(0_0_0/0.08)] transition-colors duration-150 ease-out"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      )}
    </>
  );
}
