"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Link2, Trash2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { slugCode, trackingUrl } from "@/lib/leads/origin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmDialog } from "@/components/confirm-dialog";

interface LinkRow {
  id: string;
  code: string;
  label: string;
  message: string;
}

/**
 * Tracking links (migration 134): a wa.me link per place the business
 * advertises (Instagram bio, flyer, Google). The message comes pre-typed
 * with "#code", and the webhook records the contact's origin from it.
 * Meta ads need nothing here — they arrive with their own referral.
 */
export function TrackingLinks() {
  const t = useTranslations("Settings.trackingLinks");
  const { accountId, canEditSettings } = useAuth();
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    const db = createClient();
    void db
      .from("tracking_links")
      .select("id, code, label, message")
      .order("created_at", { ascending: false })
      .then(({ data }) => setLinks((data as LinkRow[]) ?? []));
    void db
      .from("whatsapp_config")
      .select("display_phone_number, is_primary")
      .order("is_primary", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setPhone((data?.display_phone_number as string) ?? ""));
  }, [accountId]);

  async function add() {
    const code = slugCode(label);
    if (!accountId || code.length < 2) return;
    setSaving(true);
    const { data, error } = await createClient()
      .from("tracking_links")
      .insert({ account_id: accountId, code, label: label.trim(), message: message.trim() })
      .select("id, code, label, message")
      .single();
    setSaving(false);
    if (error || !data) {
      toast.error(error?.code === "23505" ? t("duplicate") : t("saveFailed"));
      return;
    }
    setLinks((prev) => [data as LinkRow, ...prev]);
    setLabel("");
    setMessage("");
  }

  async function remove(id: string) {
    await confirmDialog(t("deleteConfirm"), {
      action: async () => {
        const { error } = await createClient().from("tracking_links").delete().eq("id", id);
        if (error) {
          toast.error(t("saveFailed"));
          return;
        }
        setLinks((prev) => prev.filter((l) => l.id !== id));
      },
    });
  }

  function copy(url: string) {
    void navigator.clipboard.writeText(url).then(() => toast.success(t("copied")));
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Link2 className="size-4 text-primary" />
          {t("title")}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!phone && <p className="text-xs text-muted-foreground">{t("noNumber")}</p>}
        {canEditSettings && (
          <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="tl-label">{t("labelField")}</Label>
              <Input
                id="tl-label"
                value={label}
                maxLength={80}
                placeholder={t("labelPlaceholder")}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tl-message">{t("messageField")}</Label>
              <Input
                id="tl-message"
                value={message}
                maxLength={300}
                placeholder={t("messagePlaceholder")}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
            <Button onClick={() => void add()} disabled={saving || slugCode(label).length < 2}>
              {t("create")}
            </Button>
          </div>
        )}
        {links.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {links.map((l) => {
              const url = phone ? trackingUrl(phone, l.message, l.code) : "";
              return (
                <li key={l.id} className="flex items-center gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {l.label} <span className="font-normal text-muted-foreground">#{l.code}</span>
                    </p>
                    {url && <p className="truncate text-xs text-muted-foreground">{url}</p>}
                  </div>
                  {url && (
                    <Button variant="ghost" size="sm" onClick={() => copy(url)} aria-label={t("copy")}>
                      <Copy className="size-4" />
                    </Button>
                  )}
                  {canEditSettings && (
                    <Button variant="ghost" size="sm" onClick={() => void remove(l.id)} aria-label={t("delete")}>
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
