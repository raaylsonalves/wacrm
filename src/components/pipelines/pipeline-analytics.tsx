"use client";

import { cn } from "@/lib/utils";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import {
  DollarSign,
  TrendingUp,
  Target,
  BarChart3,
  Trophy,
  XCircle,
  Info,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
}

/**
 * Weighted pipeline value: value × per-stage probability.
 * First stage ≈ 10%, stages interpolate up to 90% before the final stage,
 * final stage (Won) = 100%. Lost deals excluded.
 */
function computeStageProbability(
  stage: PipelineStage,
  sortedStages: PipelineStage[],
): number {
  const n = sortedStages.length;
  if (n <= 1) return 1;
  const index = sortedStages.findIndex((s) => s.id === stage.id);
  if (index < 0) return 0;
  if (index === n - 1) return 1;
  const slots = n - 1;
  if (slots <= 1) return 0.1;
  const t = index / (slots - 1);
  return 0.1 + t * (0.9 - 0.1);
}

export function PipelineAnalytics({ stages, deals }: PipelineAnalyticsProps) {
  const t = useTranslations("Pipelines.analytics");
  const { defaultCurrency } = useAuth();
  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const stats = useMemo(() => {
    const active = deals.filter((d) => d.status !== "lost");
    const openDeals = active.filter((d) => d.status !== "won");

    const totalCount = active.length;

    // Deals are meant to be single-currency per account (#218), but a
    // legacy row or one created before the account's default currency
    // changed can still carry a different one — summing raw values
    // across currencies and labeling the total with `defaultCurrency`
    // silently misreports it (e.g. a USD deal counted as if BRL). Group
    // every money figure by the deal's own currency instead.
    const valueByCurrency = new Map<string, number>();
    const countByCurrency = new Map<string, number>();
    for (const d of active) {
      const cur = d.currency || defaultCurrency;
      valueByCurrency.set(cur, (valueByCurrency.get(cur) ?? 0) + Number(d.value || 0));
      countByCurrency.set(cur, (countByCurrency.get(cur) ?? 0) + 1);
    }
    const avgByCurrency = new Map(
      Array.from(valueByCurrency.entries()).map(([cur, total]) => [
        cur,
        total / (countByCurrency.get(cur) ?? 1),
      ]),
    );

    const stageById = new Map(sortedStages.map((s) => [s.id, s]));
    const weightedByCurrency = new Map<string, number>();
    for (const d of openDeals) {
      const stage = stageById.get(d.stage_id);
      if (!stage) continue;
      const prob = computeStageProbability(stage, sortedStages);
      const cur = d.currency || defaultCurrency;
      weightedByCurrency.set(
        cur,
        (weightedByCurrency.get(cur) ?? 0) + Number(d.value || 0) * prob,
      );
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = (d: Deal) => {
      const ts = d.updated_at ?? d.created_at;
      return ts ? new Date(ts) >= monthStart : false;
    };
    const wonThisMonth = deals.filter(
      (d) => d.status === "won" && thisMonth(d),
    ).length;
    const lostThisMonth = deals.filter(
      (d) => d.status === "lost" && thisMonth(d),
    ).length;

    return {
      totalCount,
      valueByCurrency,
      avgByCurrency,
      weightedByCurrency,
      wonThisMonth,
      lostThisMonth,
    };
  }, [deals, sortedStages, defaultCurrency]);

  const formatByCurrency = (map: Map<string, number>) =>
    map.size === 0
      ? formatCurrency(0, defaultCurrency)
      : Array.from(map.entries())
          .map(([cur, total]) => formatCurrency(total, cur))
          .join(" + ");

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Metric
          icon={<BarChart3 className="h-4 w-4" />}
          label={t("totalDeals")}
          value={String(stats.totalCount)}
          tooltip={t("totalDealsTooltip")}
          t={t}
        />
        <Metric
          icon={<DollarSign className="h-4 w-4" />}
          tone="lilac"
          label={t("pipelineValue")}
          value={formatByCurrency(stats.valueByCurrency)}
          tooltip={t("pipelineValueTooltip")}
          t={t}
        />
        <Metric
          icon={<Target className="h-4 w-4" />}
          label={t("avgDealSize")}
          value={formatByCurrency(stats.avgByCurrency)}
          tooltip={t("avgDealSizeTooltip")}
          t={t}
        />
        <Metric
          icon={<TrendingUp className="h-4 w-4" />}
          tone="blue"
          label={t("weightedValue")}
          value={formatByCurrency(stats.weightedByCurrency)}
          tooltip={t("weightedValueTooltip")}
          t={t}
        />
        <Metric
          icon={<Trophy className="h-4 w-4" />}
          tone="mint"
          label={t("wonThisMonth")}
          value={String(stats.wonThisMonth)}
          tooltip={t("wonThisMonthTooltip")}
          t={t}
        />
        <Metric
          icon={<XCircle className="h-4 w-4" />}
          tone="salmon"
          label={t("lostThisMonth")}
          value={String(stats.lostThisMonth)}
          tooltip={t("lostThisMonthTooltip")}
          t={t}
        />
      </div>
    </TooltipProvider>
  );
}

// v2 totals: the headline numbers sit on solid pastel tiles, the rest on
// the card surface.
const METRIC_TONE = {
  lilac: "bg-tone-lilac text-tone-on",
  mint: "bg-tone-mint text-tone-on",
  salmon: "bg-tone-salmon text-tone-on",
  blue: "bg-tone-blue text-tone-on",
} as const;

function Metric({
  icon,
  label,
  value,
  tooltip,
  tone,
  t,
}: {
  icon: React.ReactNode;
  tone?: keyof typeof METRIC_TONE;
  label: string;
  value: string;
  tooltip: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[92px] flex-col justify-between gap-2 rounded-[20px] p-3.5",
        tone ? METRIC_TONE[tone] : "border border-border bg-card text-foreground",
      )}
    >
      <div className={cn("flex items-center gap-1.5 text-xs font-semibold", tone ? "opacity-80" : "text-muted-foreground")}>
        {icon}
        <span>{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t("howCalculated", { label })}
                className="ml-auto opacity-70 hover:opacity-100 focus:outline-none"
              />
            }
          >
            <Info className="h-3 w-3" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="text-lg leading-tight font-bold tracking-tight tabular-nums">{value}</p>
    </div>
  );
}
