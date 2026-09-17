"use client"

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import {
  MessageSquare,
  UserPlus,
  DollarSign,
  Send,
} from 'lucide-react'

import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'

import { RefreshCw } from 'lucide-react'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { PipelineDonut } from '@/components/dashboard/pipeline-donut'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'

import { useTranslations } from 'next-intl'

type RangeDays = 7 | 30 | 90

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')
  const tActivity = useTranslations('Dashboard.activityFeed')
  const { defaultCurrency } = useAuth()
  const [metrics, setMetrics] = useState<MetricsBundle | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)
  const [metricsError, setMetricsError] = useState(false)

  const [range, setRange] = useState<RangeDays>(30)
  // Keep a cache per range so switching tabs doesn't re-fetch what we
  // already have. Ranges the user hasn't opened yet stay null and
  // trigger a fetch on first view.
  const [series, setSeries] = useState<Record<RangeDays, ConversationsSeriesPoint[] | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [seriesLoading, setSeriesLoading] = useState(true)
  const [seriesError, setSeriesError] = useState(false)

  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null)
  const [pipelineLoading, setPipelineLoading] = useState(true)
  const [pipelineError, setPipelineError] = useState(false)

  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null)
  const [responseTimeLoading, setResponseTimeLoading] = useState(true)
  const [responseTimeError, setResponseTimeError] = useState(false)

  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)
  const [activityError, setActivityError] = useState(false)

  const loadAll = useCallback(() => {
    const db = createClient()

    // Kick everything off in parallel. Each block has its own
    // setState + finally so a slow query doesn't hold up faster
    // sections — each widget shows its own skeleton independently.
    // Every loader also tracks its own error flag — a failed query used
    // to leave `loading=false, data=null` indistinguishable from "still
    // loading" (both render the skeleton forever, per the `loading ||
    // !data` checks below and in each child component), with no way to
    // tell the user anything was wrong or let them retry.
    // Each `.then` also clears its error flag (rather than resetting it
    // synchronously up front) so a retry that succeeds clears the error
    // banner without a synchronous setState call inside this
    // effect-invoked function.
    void loadMetrics(db)
      .then((m) => {
        setMetrics(m)
        setMetricsError(false)
      })
      .catch((err) => {
        console.error('[dashboard] metrics failed:', err)
        setMetricsError(true)
      })
      .finally(() => setMetricsLoading(false))

    void loadConversationsSeries(db, 30)
      .then((s) => {
        setSeries((prev) => ({ ...prev, 30: s }))
        setSeriesError(false)
      })
      .catch((err) => {
        console.error('[dashboard] series failed:', err)
        setSeriesError(true)
      })
      .finally(() => setSeriesLoading(false))

    void loadPipelineDonut(db)
      .then((p) => {
        setPipeline(p)
        setPipelineError(false)
      })
      .catch((err) => {
        console.error('[dashboard] pipeline failed:', err)
        setPipelineError(true)
      })
      .finally(() => setPipelineLoading(false))

    void loadResponseTime(db)
      .then((r) => {
        setResponseTime(r)
        setResponseTimeError(false)
      })
      .catch((err) => {
        console.error('[dashboard] response time failed:', err)
        setResponseTimeError(true)
      })
      .finally(() => setResponseTimeLoading(false))

    // Fetch up to 50 so the biggest page-size option in the feed
    // (50 rows) is already in memory — switching sizes then becomes
    // a pure client-side slice with no extra round trip.
    void loadActivity(db, 50, tActivity)
      .then((a) => {
        setActivity(a)
        setActivityError(false)
      })
      .catch((err) => {
        console.error('[dashboard] activity failed:', err)
        setActivityError(true)
      })
      .finally(() => setActivityLoading(false))
  }, [tActivity])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // Range switch handler — kept in an event callback (not an effect)
  // so the setState calls stay out of the react-hooks/set-state-in-effect
  // rule's way. The cached bucket check means switching back to a
  // previously-viewed range is instant and doesn't re-fetch.
  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      if (series[r] !== null) return
      setSeriesLoading(true)
      setSeriesError(false)
      const db = createClient()
      loadConversationsSeries(db, r)
        .then((s) => setSeries((prev) => ({ ...prev, [r]: s })))
        .catch((err) => {
          console.error('[dashboard] series failed:', err)
          setSeriesError(true)
        })
        .finally(() => setSeriesLoading(false))
    },
    [series],
  )

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('description')}
        </p>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {!metricsLoading && metricsError ? (
          <div className="sm:col-span-2 lg:col-span-4">
            <WidgetError onRetry={loadAll} t={t} />
          </div>
        ) : metricsLoading || !metrics ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('activeConversations')}
              value={metrics.activeConversations.current.toLocaleString()}
              icon={MessageSquare}
              delta={{
                sign: metrics.activeConversations.previous,
                label: deltaLabel(
                  metrics.activeConversations.previous, 
                  t('newTodayVsYesterday'), 
                  t('noChange', { suffix: t('newTodayVsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('newContactsToday')}
              value={metrics.newContactsToday.current.toLocaleString()}
              icon={UserPlus}
              delta={{
                sign:
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                label: deltaLabel(
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                  t('vsYesterday'),
                  t('noChange', { suffix: t('vsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('openDealsValue')}
              value={
                Object.keys(metrics.openDealsValueByCurrency).length === 0
                  ? formatCurrency(0, defaultCurrency)
                  : Object.entries(metrics.openDealsValueByCurrency)
                      .map(([cur, total]) => formatCurrency(total, cur))
                      .join(' + ')
              }
              icon={DollarSign}
              subtitle={t('openDeals', { count: metrics.openDealsCount })}
            />
            <MetricCard
              title={t('messagesSentToday')}
              value={metrics.messagesSentToday.current.toLocaleString()}
              icon={Send}
              delta={{
                sign:
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                label: deltaLabel(
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                  t('vsYesterday'),
                  t('noChange', { suffix: t('vsYesterday') })
                ),
              }}
            />
          </>
        )}
      </div>

      {/* Quick actions */}
      <QuickActions />

      {/* Charts row */}
      {/* items-stretch (the grid default) stretches the two columns to
          match the tallest sibling; adding h-full on each wrapper and
          on the inner panels makes both cards actually fill that
          stretched height so their rounded borders line up. Without
          this, the pipeline card rendered at its natural (shorter)
          height while the line chart drove the row height. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-full lg:col-span-3">
          {!seriesLoading && seriesError ? (
            <WidgetError onRetry={loadAll} t={t} />
          ) : (
            <ConversationsChart
              series={series}
              loading={seriesLoading}
              range={range}
              onRangeChange={handleRangeChange}
            />
          )}
        </div>
        <div className="h-full lg:col-span-2">
          {!pipelineLoading && pipelineError ? (
            <WidgetError onRetry={loadAll} t={t} />
          ) : (
            <PipelineDonut
              data={pipeline}
              loading={pipelineLoading}
              currency={defaultCurrency}
            />
          )}
        </div>
      </div>

      {/* Response time */}
      {!responseTimeLoading && responseTimeError ? (
        <WidgetError onRetry={loadAll} t={t} />
      ) : (
        <ResponseTimeChart data={responseTime} loading={responseTimeLoading} />
      )}

      {/* Activity feed */}
      {!activityLoading && activityError ? (
        <WidgetError onRetry={loadAll} t={t} />
      ) : (
        <ActivityFeed items={activity} loading={activityLoading} />
      )}
    </div>
  )
}

// ------------------------------------------------------------

function deltaLabel(delta: number, suffix: string, noChangeLabel: string): string {
  if (delta === 0) return noChangeLabel
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toLocaleString()} ${suffix}`
}

/**
 * A failed widget query used to be indistinguishable from "still
 * loading" — both left the child rendering its own skeleton forever
 * (`loading || !data`), with no signal that anything was actually
 * wrong and no way to retry short of a full page reload. Swapped in
 * per-widget when its loader's promise rejects.
 */
function WidgetError({
  onRetry,
  t,
}: {
  onRetry: () => void
  t: (key: string) => string
}) {
  return (
    <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 p-6 text-center">
      <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {t('retry')}
      </button>
    </div>
  )
}
