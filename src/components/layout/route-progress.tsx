'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * Thin bar along the top of the content area while moving between pages
 * (the v7 rule: the sticker mural only on the first load, this on every
 * other navigation). The App Router has no navigation events, so it starts
 * on a click on an internal link to another path and finishes when the
 * pathname actually changes. Driven with the Web Animations API on a ref —
 * no React state, so it never re-renders the shell.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const barRef = useRef<HTMLDivElement>(null);
  const running = useRef(false);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest('a');
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      const el = barRef.current;
      if (!el) return;
      running.current = true;
      el.getAnimations().forEach((anim) => anim.cancel());
      el.animate([{ opacity: 1, transform: 'scaleX(0)' }, { opacity: 1, transform: 'scaleX(0.7)' }], {
        duration: 400,
        easing: EASE_OUT,
        fill: 'forwards',
      });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    const el = barRef.current;
    if (!el || !running.current) return;
    running.current = false;
    const from = getComputedStyle(el).transform;
    el.getAnimations().forEach((anim) => anim.cancel());
    el.animate(
      [
        { opacity: 1, transform: from === 'none' ? 'scaleX(0)' : from },
        { opacity: 1, transform: 'scaleX(1)', offset: 0.6 },
        { opacity: 0, transform: 'scaleX(1)' },
      ],
      { duration: 400, easing: 'ease-out', fill: 'forwards' }
    );
  }, [pathname]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-50 h-[3px] overflow-hidden">
      <div ref={barRef} className="bg-foreground h-full w-full origin-left opacity-0" />
    </div>
  );
}
