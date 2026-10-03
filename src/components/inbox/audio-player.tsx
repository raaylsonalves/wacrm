'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  fallbackPeaks,
  formatDuration,
  peaksFromChannel,
  WAVE_BARS,
} from '@/lib/inbox/audio-wave';

const SPEEDS = [1, 1.5, 2] as const;
/** Bigger than this isn't worth decoding just to draw bars. */
const MAX_DECODE_BYTES = 3 * 1024 * 1024;

/**
 * WhatsApp-style voice note: play/pause, a waveform that fills as it plays
 * (tap to seek), the time, and a 1x/1.5x/2x speed toggle. The bars are the
 * real peaks when the browser can decode the file (decoded once the bubble
 * scrolls into view); otherwise a stable pseudo-waveform from the message
 * id — Safari can't decode Opus, and that must not break the bubble.
 */
export function AudioPlayer({
  src,
  seed,
  outgoing,
}: {
  src: string;
  seed: string;
  outgoing: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const fallback = useMemo(() => fallbackPeaks(seed), [seed]);
  const [peaks, setPeaks] = useState<number[]>(fallback);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void (async () => {
        try {
          const res = await fetch(src);
          const len = Number(res.headers.get('content-length') ?? 0);
          if (!res.ok || len > MAX_DECODE_BYTES) return;
          const buf = await res.arrayBuffer();
          if (buf.byteLength > MAX_DECODE_BYTES) return;
          const Ctx =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (!Ctx) return;
          const ctx = new Ctx();
          try {
            const decoded = await ctx.decodeAudioData(buf);
            if (!cancelled)
              setPeaks(peaksFromChannel(decoded.getChannelData(0), WAVE_BARS));
          } finally {
            void ctx.close();
          }
        } catch {
          /* keep the pseudo-waveform */
        }
      })();
    });
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [src]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }

  function cycleSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const a = audioRef.current;
    if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime =
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) *
      a.duration;
  }

  const progress = duration > 0 ? current / duration : 0;

  return (
    <div ref={rootRef} className="flex w-56 items-center gap-2 py-0.5">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          outgoing
            ? 'bg-primary-foreground/20 text-primary-foreground'
            : 'bg-foreground text-background'
        )}
      >
        {playing ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="ml-0.5 h-4 w-4" />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div
          onClick={seek}
          className="flex h-7 cursor-pointer items-center gap-[2px]"
        >
          {peaks.map((p, i) => (
            <span
              key={i}
              className={cn(
                'w-[3px] shrink-0 rounded-full',
                i / peaks.length < progress
                  ? outgoing
                    ? 'bg-primary-foreground'
                    : 'bg-primary'
                  : outgoing
                    ? 'bg-primary-foreground/40'
                    : 'bg-muted-foreground/40'
              )}
              style={{ height: `${Math.round(p * 100)}%` }}
            />
          ))}
        </div>
        <div
          className={cn(
            'flex items-center justify-between text-[10px] tabular-nums',
            outgoing ? 'text-primary-foreground/70' : 'text-muted-foreground'
          )}
        >
          <span>
            {formatDuration(playing || current > 0 ? current : duration)}
          </span>
          <button
            type="button"
            onClick={cycleSpeed}
            className="rounded px-1 font-semibold hover:bg-black/10"
          >
            {speed}x
          </button>
        </div>
      </div>
    </div>
  );
}
