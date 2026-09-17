"use client"

import { Clock } from 'lucide-react'
import type { ResponseTimeSummary } from '@/lib/dashboard/types'
import { BarChart } from '@/components/tremor/bar-chart'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface ResponseTimeChartProps {
  data: ResponseTimeSummary | null
  loading: boolean
  /** Minutes. Surfaced as a "target" pill in the header. The
   *  hand-rolled SVG version drew this as a horizontal dashed
   *  line on the chart; Tremor BarChart doesn't expose Recharts
   *  primitives, so we promote it to the header for now. A
   *  follow-up can introduce an overlay or extend the vendored
   *  BarChart with a `referenceLines` prop. */
  thresholdMinutes?: number
}

import { useTranslations } from 'next-intl'

export function ResponseTimeChart({
  data,
  loading,
  thresholdMinutes = 5,
}: ResponseTimeChartProps) {
  const t = useTranslations('Dashboard.responseTimeChart')
  const dowShort = t.raw('dowShortMonFirst') as string[]
  // Single category, single colour — the data is "average response
  // time per weekday". Tremor expects categories as the second tuple
  // in the row object, so we shape the buckets into
  // `{ day: 'Mon', [avgResponseTimeLabel]: 4.2 }` rows below. Translated
  // (not a module-level constant) because it also doubles as the
  // series name Tremor's tooltip shows on hover. Named response-time
  // rather than "minutes" — the values plotted are always minutes, but
  // the axis/tooltip render them in whatever unit (s/m/h) fits, via
  // `unit` below.
  const category = t('avgResponseTimeLabel')
  const hasData = data?.buckets.some((b) => b.avgMinutes != null) ?? false

  // Map buckets → Tremor rows. Null `avgMinutes` (no samples)
  // collapses to 0; the chart will render an empty slot for it.
  // We attach `samples` on the row so a future customTooltip can
  // surface "no samples" copy without losing the data shape.
  const chartData =
    data?.buckets.map((b, i) => ({
      day: dowShort[i],
      [category]: b.avgMinutes ?? 0,
      samples: b.samples,
    })) ?? []

  // Tremor calls valueFormatter independently for every axis gridline
  // AND the tooltip — formatting each value's own magnitude (seconds
  // for a near-zero tick, hours for the tallest bar) produced an axis
  // that mixed "0s"/"5.0h"/"17.0h" on the same scale. Pick ONE unit for
  // the whole chart from its largest value, so every tick/tooltip uses
  // the same unit consistently.
  const maxMinutes = Math.max(0, ...chartData.map((d) => d[category] as number))
  const unit: 'seconds' | 'minutes' | 'hours' =
    maxMinutes < 1 ? 'seconds' : maxMinutes < 60 ? 'minutes' : 'hours'
  const formatForUnit = (mins: number) => {
    if (unit === 'seconds') return `${Math.round(mins * 60)}s`
    if (unit === 'minutes') return `${mins.toFixed(1)}m`
    return `${(mins / 60).toFixed(1)}h`
  }

  // Tremor's yAxisWidth is a fixed pixel reservation, not an
  // auto-sizing one — a width tuned for "0.0h" clips the leading
  // digit of "20.0h" once the chart's max value pushes into two-digit
  // hours. Size it off the longest tick label this data will actually
  // render instead of a constant.
  const longestTick = formatForUnit(maxMinutes).length
  const yAxisWidth = Math.max(40, longestTick * 8 + 16)

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('description')}
          </p>
        </div>
        <div className="flex items-center gap-3 text-right text-xs">
          {thresholdMinutes > 0 && (
            <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 font-medium text-rose-300 tabular-nums">
              {t('target', { minutes: thresholdMinutes })}
            </span>
          )}
          {data && (data.thisWeekAvg != null || data.lastWeekAvg != null) && (
            <div>
              <div className="text-muted-foreground">
                {t('thisWeek')}{' '}
                <span className="font-medium text-foreground tabular-nums">
                  {fmt(data.thisWeekAvg)}
                </span>
              </div>
              <div className="text-muted-foreground">
                {t('lastWeek')}{' '}
                <span className="tabular-nums">{fmt(data.lastWeekAvg)}</span>
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="p-5">
        {loading || !data ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !hasData ? (
          <EmptyState
            icon={Clock}
            title={t('noReplies')}
            hint={t('noRepliesHint')}
          />
        ) : (
          <BarChart
            data={chartData}
            index="day"
            categories={[category]}
            // 'violet' maps to Tailwind's `fill-violet-500` — matches
            // the brand accent the hand-rolled bars used (#7c3aed).
            colors={['violet']}
            valueFormatter={formatForUnit}
            showLegend={false}
            yAxisWidth={yAxisWidth}
            // Compact height so the chart sits well inside the card
            // without dominating the row alongside the donut + activity feed.
            className="h-[260px]"
          />
        )}
      </div>
    </section>
  )
}

function fmt(mins: number | null): string {
  if (mins == null) return '—'
  if (mins <= 0) return '0s'
  if (mins < 1) return `${Math.max(1, Math.round(mins * 60))}s`
  if (mins < 60) return `${mins.toFixed(1)}m`
  return `${(mins / 60).toFixed(1)}h`
}
