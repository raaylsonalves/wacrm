"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Building2, Loader2, Trash2, Upload } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { isValidHexColor } from "@/lib/color-contrast";
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

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);

/**
 * Settings → Branding — account-wide logo, display name, and brand
 * color (see specs/account-branding.md). Admin+ only, same gating
 * pattern as DealsSettings: `accounts_update` RLS already restricts
 * writes, non-admins see a disabled, read-only view.
 */
export function BrandingSettings() {
  const t = useTranslations("Settings.branding");
  const supabase = createClient();
  const { user, accountId, account, canEditSettings, profileLoading, refreshProfile } =
    useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [displayName, setDisplayName] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [pendingLogo, setPendingLogo] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed form state once the account resolves, and after a save
  // round-trips through refreshProfile.
  useEffect(() => {
    setDisplayName(account?.display_name ?? "");
    setBrandColor(account?.brand_color ?? "");
  }, [account?.display_name, account?.brand_color]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const currentLogo =
    previewUrl ?? (!removeLogo ? account?.logo_url ?? null : null);

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!ALLOWED_MIME.has(file.type)) {
      toast.error(t("unsupportedImage"), {
        description: t("unsupportedImageDesc"),
      });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(t("imageTooLarge"), { description: t("imageTooLargeDesc") });
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingLogo(file);
    setPreviewUrl(URL.createObjectURL(file));
    setRemoveLogo(false);
  };

  const onRemoveLogo = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingLogo(null);
    setPreviewUrl(null);
    setRemoveLogo(true);
  };

  const trimmedColor = brandColor.trim();
  const colorInvalid = trimmedColor !== "" && !isValidHexColor(trimmedColor);

  const dirty =
    displayName.trim() !== (account?.display_name ?? "") ||
    trimmedColor !== (account?.brand_color ?? "") ||
    pendingLogo !== null ||
    removeLogo;

  async function handleSave() {
    if (!user || !accountId || !dirty || colorInvalid) return;
    setSaving(true);
    try {
      let nextLogoUrl: string | null = account?.logo_url ?? null;

      if (pendingLogo) {
        const ext = pendingLogo.name.split(".").pop()?.toLowerCase() || "png";
        const path = `${accountId}/logo-${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("account-logos")
          .upload(path, pendingLogo, {
            cacheControl: "3600",
            upsert: true,
            contentType: pendingLogo.type,
          });
        if (uploadError) {
          throw new Error(t("uploadFailed", { message: uploadError.message }));
        }
        const {
          data: { publicUrl },
        } = supabase.storage.from("account-logos").getPublicUrl(path);
        nextLogoUrl = publicUrl;
      } else if (removeLogo) {
        nextLogoUrl = null;
      }

      const { error } = await supabase
        .from("accounts")
        .update({
          display_name: displayName.trim() || null,
          brand_color: trimmedColor || null,
          logo_url: nextLogoUrl,
        })
        .eq("id", accountId);
      if (error) throw new Error(error.message);

      setPendingLogo(null);
      setPreviewUrl(null);
      setRemoveLogo(false);
      await refreshProfile();
      toast.success(t("saveSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const disabled = !canEditSettings || profileLoading || saving;

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Building2 className="size-4 text-primary" />
            {t("title")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {!canEditSettings && t("adminOnlyHint")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Logo */}
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t("logoLabel")}</Label>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
                {currentLogo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- user-uploaded Storage URL, not a static local asset
                  <img src={currentLogo} alt="" className="h-full w-full object-contain" />
                ) : (
                  <Building2 className="size-6 text-muted-foreground" />
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={onPickFile}
                  disabled={disabled}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled}
                >
                  <Upload className="size-4" />
                  {currentLogo ? t("changeLogo") : t("uploadLogo")}
                </Button>
                {currentLogo && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={onRemoveLogo}
                    disabled={disabled}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Trash2 className="size-4" />
                    {t("removeLogo")}
                  </Button>
                )}
                <p className="w-full text-xs text-muted-foreground">{t("logoHint")}</p>
              </div>
            </div>
          </div>

          {/* Display name */}
          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="branding-display-name" className="text-muted-foreground">
              {t("displayNameLabel")}
            </Label>
            <Input
              id="branding-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("displayNamePlaceholder")}
              maxLength={80}
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">{t("displayNameHint")}</p>
          </div>

          {/* Brand color */}
          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="branding-brand-color" className="text-muted-foreground">
              {t("brandColorLabel")}
            </Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label={t("brandColorLabel")}
                value={isValidHexColor(trimmedColor) ? trimmedColor : "#7c3aed"}
                onChange={(e) => setBrandColor(e.target.value)}
                disabled={disabled}
                className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-muted p-1 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <Input
                id="branding-brand-color"
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                placeholder="#7c3aed"
                maxLength={7}
                disabled={disabled}
                className="font-mono"
              />
            </div>
            {colorInvalid ? (
              <p className="text-xs text-red-400">{t("invalidColor")}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("brandColorHint")}</p>
            )}
            {trimmedColor !== "" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setBrandColor("")}
                disabled={disabled}
                className="w-fit text-muted-foreground hover:text-foreground"
              >
                {t("resetColor")}
              </Button>
            )}
          </div>

          {canEditSettings && (
            <Button onClick={handleSave} disabled={disabled || !dirty || colorInvalid}>
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
