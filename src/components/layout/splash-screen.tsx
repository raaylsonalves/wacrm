'use client';

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { Sticker, type StickerKind } from '@/components/layout/sticker';
import { cn } from '@/lib/utils';

const SEEN_KEY = 'wacrm.splashSeen';
/** The mural needs this long to land before it may leave (first visit only). */
const MURAL_MIN_MS = 900;
/** Matches the longest leave transition in globals.css (.splash). */
const LEAVE_MS = 400;

// Sticker layout around the centred progress bar, in % of the stage so it
// scales from a 375px phone to a wide monitor without re-tuning.
const STICKERS: Array<{ kind: StickerKind; left: number; top: number; w: number; r: number }> = [
  { kind: 'conversa', left: 8, top: 12, w: 17, r: -8 },
  { kind: 'ganho', left: 58, top: 2, w: 14, r: 8 },
  { kind: 'agenda', left: 80, top: 16, w: 15, r: 6 },
  { kind: 'crescimento', left: 78, top: 62, w: 16, r: -5 },
  { kind: 'ia', left: 44, top: 72, w: 13, r: -4 },
  { kind: 'enviado', left: 6, top: 64, w: 14, r: 7 },
];

// "mural" on the first load of a browser session, "bar" afterwards (a full
// reload mid-session shouldn't replay the whole intro). Read through
// useSyncExternalStore so the server and the first client render agree
// ("pending" — just the background) and the real value lands right after
// hydration without a setState-in-effect. Cached so the snapshot is stable.
let cachedVariant: 'mural' | 'bar' | null = null;
function readVariant(): 'mural' | 'bar' {
  if (cachedVariant) return cachedVariant;
  try {
    cachedVariant = sessionStorage.getItem(SEEN_KEY) ? 'bar' : 'mural';
  } catch {
    cachedVariant = 'bar';
  }
  return cachedVariant;
}
const noopSubscribe = () => () => {};

/**
 * Opening screen of the dashboard (v7 "mural de abertura"): six stickers
 * settle around a thin progress bar while the session loads, then fade out
 * to reveal the app. Shown in full only once per browser session; later
 * loads get the bar alone. It never holds the app back for more than
 * MURAL_MIN_MS once data is ready.
 */
export function SplashScreen({ ready }: { ready: boolean }) {
  const t = useTranslations('DashboardShell');
  const variant = useSyncExternalStore(noopSubscribe, readVariant, () => 'pending' as const);
  const [startedAt] = useState(() => Date.now());
  const [phase, setPhase] = useState<'show' | 'leave' | 'gone'>('show');

  useEffect(() => {
    if (!ready || phase !== 'show' || variant === 'pending') return;
    const wait = variant === 'mural' ? Math.max(0, MURAL_MIN_MS - (Date.now() - startedAt)) : 0;
    const id = setTimeout(() => {
      try {
        sessionStorage.setItem(SEEN_KEY, '1');
      } catch {
        /* private mode — the intro just replays next load */
      }
      setPhase('leave');
    }, wait);
    return () => clearTimeout(id);
  }, [ready, phase, variant, startedAt]);

  useEffect(() => {
    if (phase !== 'leave') return;
    const id = setTimeout(() => setPhase('gone'), LEAVE_MS);
    return () => clearTimeout(id);
  }, [phase]);

  if (phase === 'gone') return null;

  return (
    <div
      className="splash bg-background fixed inset-0 z-[100] flex items-center justify-center"
      data-leaving={phase === 'leave' ? '' : undefined}
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{t('loading')}</span>
      {variant === 'mural' ? (
        <div className="relative aspect-[760/520] w-[min(94vw,760px)]">
          <div className="splash-card bg-card border-border absolute top-1/2 left-1/2 flex w-[46%] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[22px] border px-[6%] py-[5%] shadow-[0_20px_50px_rgb(29_27_24/0.12)]">
            <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
              <div className="splash-bar bg-foreground h-full w-full origin-left rounded-full" />
            </div>
          </div>
          {STICKERS.map((s, i) => (
            <Sticker
              key={s.kind}
              kind={s.kind}
              className="splash-sticker absolute h-auto"
              style={
                {
                  left: `${s.left}%`,
                  top: `${s.top}%`,
                  width: `${s.w}%`,
                  '--r': `${s.r}deg`,
                  '--r-in': `${i % 2 ? 8 : -8}deg`,
                  '--i': i,
                } as CSSProperties
              }
            />
          ))}
        </div>
      ) : (
        <div className={cn('absolute inset-x-0 top-0 h-[3px]', variant === 'pending' && 'invisible')}>
          <div className="splash-bar bg-foreground h-full w-full origin-left" />
        </div>
      )}
    </div>
  );
}
