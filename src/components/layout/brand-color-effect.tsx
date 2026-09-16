"use client";

import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { getContrastForeground, isValidHexColor } from "@/lib/color-contrast";

/**
 * Headless — renders nothing. Overrides `--primary` /
 * `--primary-foreground` (and the derived hover/soft/ring/chart
 * tokens that key off the same hue in globals.css) with the current
 * account's `brand_color`, if one is set.
 *
 * Deliberately NOT applied via the pre-hydration boot script the way
 * `data-theme`/`data-mode` are: account branding lives in Postgres,
 * not `localStorage`, so it can't be read synchronously before first
 * paint. A brief default-theme flash before the account loads is an
 * accepted trade-off (see specs/account-branding.md — "Decisions").
 */
export function BrandColorEffect() {
  const { account } = useAuth();
  const brandColor = account?.brand_color ?? null;

  useEffect(() => {
    const root = document.documentElement;
    if (!brandColor || !isValidHexColor(brandColor)) {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--primary-foreground");
      root.style.removeProperty("--primary-hover");
      root.style.removeProperty("--ring");
      return;
    }
    const foreground = getContrastForeground(brandColor);
    root.style.setProperty("--primary", brandColor);
    root.style.setProperty("--primary-foreground", foreground);
    // No separate hover shade for an arbitrary admin-picked color —
    // reuse the same value rather than guessing a lighten/darken that
    // could invert badly on an already-light or already-dark pick.
    root.style.setProperty("--primary-hover", brandColor);
    root.style.setProperty("--ring", brandColor);

    return () => {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--primary-foreground");
      root.style.removeProperty("--primary-hover");
      root.style.removeProperty("--ring");
    };
  }, [brandColor]);

  return null;
}
