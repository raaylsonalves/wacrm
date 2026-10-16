"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Store } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { segmentQueryKey, useSegment } from "@/hooks/use-segment";
import { SEGMENTS, profileFor, stageRows, type Segment } from "@/lib/segments/profiles";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Segment profile (migration 135): picks what deals are called, the
 * default funnel, which dashboard blocks show first and the order of
 * loss reasons. Nothing is removed — it only changes defaults.
 */
export function SegmentSettings() {
  const t = useTranslations("Segments");
  const tSeg = useTranslations("Onboarding.profile.segment");
  const { accountId, user, canEditSettings } = useAuth();
  const queryClient = useQueryClient();
  const { segment } = useSegment();
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  const current = segment ?? "other";
  const profile = profileFor(current);
  const stages = t.raw(`stages.${current}`) as string[];

  async function choose(next: Segment) {
    if (!accountId || next === segment) return;
    setSaving(true);
    const { error } = await createClient().from("accounts").update({ segment: next }).eq("id", accountId);
    setSaving(false);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    queryClient.setQueryData(segmentQueryKey(accountId), next);
  }

  async function createPipeline() {
    if (!accountId || !user) return;
    setCreating(true);
    const db = createClient();
    const { data: pipeline, error } = await db
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name: t(`pipelineName.${current}`) })
      .select("id")
      .single();
    if (!error && pipeline) {
      const { error: stageError } = await db
        .from("pipeline_stages")
        .insert(stageRows(stages).map((s) => ({ ...s, pipeline_id: pipeline.id })));
      if (stageError) console.error("Failed to seed segment stages:", stageError);
    }
    setCreating(false);
    if (error || !pipeline) {
      toast.error(t("pipelineFailed"));
      return;
    }
    toast.success(t("pipelineCreated"));
  }

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Store className="size-4 text-primary" />
          {t("title")}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="radiogroup" aria-label={t("title")} className="flex flex-wrap gap-1.5">
          {SEGMENTS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={current === s}
              disabled={!canEditSettings || saving}
              onClick={() => void choose(s)}
              className={cn(
                "min-h-9 rounded-full border px-3.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed",
                current === s ? "bg-foreground text-background border-transparent" : "border-border hover:bg-muted"
              )}
            >
              {tSeg(s)}
            </button>
          ))}
        </div>

        <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
          <dt className="text-muted-foreground">{t("termLabel")}</dt>
          <dd className="font-semibold">{t(`term.${profile.term}`)}</dd>
          <dt className="text-muted-foreground">{t("funnelLabel")}</dt>
          <dd className="font-semibold">{stages.join(" → ")}</dd>
          <dt className="text-muted-foreground">{t("blocksLabel")}</dt>
          <dd className="font-semibold">
            {[profile.blocks.agenda && t("blockAgenda"), profile.blocks.sales && t("blockSales")].filter(Boolean).join(" · ") || "—"}
          </dd>
        </dl>

        {canEditSettings && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => void createPipeline()} disabled={creating}>
              {t("createPipeline")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("createPipelineHint")}</p>
          </div>
        )}
        {!canEditSettings && <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>}
      </CardContent>
    </Card>
  );
}
