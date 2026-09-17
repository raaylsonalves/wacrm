"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Clock, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Response time settings — the account-wide SLA target shown as the
 * "target Xm" pill on the dashboard's response-time chart. Before this
 * panel existed, that number was a hardcoded default (5) baked into
 * the chart component with nowhere in the app to change it.
 *
 * Mirrors deals-settings.tsx: writes go straight to
 * `accounts.response_time_target_minutes`, gated the same way
 * `accounts_update` RLS (017) gates default_currency — admins+ only.
 */
export function ResponseTimeSettings() {
  const supabase = createClient();
  const {
    accountId,
    responseTimeTargetMinutes,
    canEditSettings,
    profileLoading,
    refreshProfile,
  } = useAuth();

  const [minutes, setMinutes] = useState(String(responseTimeTargetMinutes));
  const [saving, setSaving] = useState(false);
  const t = useTranslations("Settings.responseTime");

  useEffect(() => {
    setMinutes(String(responseTimeTargetMinutes));
  }, [responseTimeTargetMinutes]);

  const parsed = Number(minutes);
  const valid = Number.isInteger(parsed) && parsed > 0;
  const dirty = valid && parsed !== responseTimeTargetMinutes;

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({ response_time_target_minutes: parsed })
      .eq("id", accountId);
    if (error) {
      toast.error(t("saveFailed"));
      setSaving(false);
      return;
    }
    await refreshProfile();
    setSaving(false);
    toast.success(t("saveSuccess"));
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Clock className="size-4 text-primary" />
            {t("targetLabel")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("targetDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">{t("minutesLabel")}</Label>
            <Input
              type="number"
              min={1}
              step={1}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              disabled={!canEditSettings || profileLoading}
              className="w-full"
            />
            {!canEditSettings && (
              <p className="text-xs text-muted-foreground">
                {t("adminOnlyHint")}
              </p>
            )}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
