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
 * Branding lives in Postgres, so the first visit can't know it before
 * paint. The last value is cached in localStorage and applied by the
 * pre-hydration boot script in app/layout.tsx, so a reload no longer
 * flashes the default palette before the account loads.
 */
const CACHE_KEY = "wacrm.brandColor";
export function BrandColorEffect() {
  const { account } = useAuth();
  const brandColor = account?.brand_color ?? null;

  useEffect(() => {
    const root = document.documentElement;
    // Wait for the account: until it loads, keep what the boot script set.
    if (account === null || account === undefined) return;
    if (!brandColor || !isValidHexColor(brandColor)) {
      try {
        localStorage.removeItem(CACHE_KEY);
      } catch {}
      root.style.removeProperty("--primary");
      root.style.removeProperty("--primary-foreground");
      root.style.removeProperty("--primary-hover");
      root.style.removeProperty("--ring");
      return;
    }
    const foreground = getContrastForeground(brandColor);
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ color: brandColor, fg: foreground })
      );
    } catch {}
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
  }, [account, brandColor]);

  return null;
}
