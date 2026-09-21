// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  /**
   * Keyed by currency — deals are meant to be single-currency per
   * account (#218), but a legacy row can still carry a different one,
   * and summing them into one number under a single assumed currency
   * silently misreports the total.
   */
  openDealsValueByCurrency: Record<string, number>
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  /**
   * Deal value is meant to be single-currency per account (#218), but a
   * legacy row or one created before the account's default currency
   * changed can still carry a different one. Keyed by currency instead
   * of a single blended number — summing raw values across currencies
   * and labeling the total with one currency silently misreports it
   * (e.g. a USD deal counted as if BRL).
   */
  totalValueByCurrency: Record<string, number>
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValueByCurrency: Record<string, number>
  /** True when open deals span more than one currency — the ring then
   *  falls back to deal-count proportions since value isn't comparable
   *  across currencies without an FX rate. */
  hasMultipleCurrencies: boolean
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}
