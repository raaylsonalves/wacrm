import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

export type MetricTone = 'lilac' | 'mint' | 'salmon' | 'blue'

// v2 KPI cards: a solid pastel swatch with ink text. Static class strings
// so Tailwind can see them.
const TONE: Record<MetricTone, string> = {
  lilac: 'bg-tone-lilac',
  mint: 'bg-tone-mint',
  salmon: 'bg-tone-salmon',
  blue: 'bg-tone-blue',
}

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  tone?: MetricTone
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
}

export function MetricCard({ title, value, icon: Icon, tone = 'lilac', delta, subtitle }: MetricCardProps) {
  return (
    <div
      className={cn(
        'text-tone-on flex min-h-[124px] flex-col justify-between gap-3 rounded-[22px] p-4 sm:p-[18px]',
        TONE[tone],
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-[#1d1b18] text-white">
          <Icon className="size-[17px]" />
        </span>
        <p className="min-w-0 text-[13px] leading-tight font-semibold sm:text-sm">{title}</p>
      </div>
      <div>
        <p className="text-[26px] leading-none font-bold tracking-tight tabular-nums sm:text-[32px]">{value}</p>
        {delta ? (
          <DeltaRow sign={delta.sign} label={delta.label} />
        ) : subtitle ? (
          <p className="mt-1.5 text-xs opacity-75">{subtitle}</p>
        ) : null}
      </div>
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  // Fixed dark inks: the card is always a light pastel, in either mode.
  const tone = sign > 0 ? 'text-[#1d6a46]' : sign < 0 ? 'text-[#8e2b49]' : 'opacity-75'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('mt-1.5 flex items-center gap-1 text-xs font-medium', tone)}>
      <Arrow className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate tabular-nums">{label}</span>
    </div>
  )
}
