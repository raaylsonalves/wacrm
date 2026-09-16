/**
 * Auto-computed foreground for an admin-picked account brand color
 * (see specs/account-branding.md — "Decisions"). No second color
 * picker: pick whichever of black/white has more contrast against
 * the given background, via WCAG relative luminance. A pastel brand
 * color reads as "passable, a bit flat" rather than hand-tuned near-
 * white — an accepted trade-off for not asking the admin for a
 * second value.
 */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidHexColor(value: string): boolean {
  return HEX_RE.test(value.trim());
}

/** WCAG relative luminance of a single sRGB channel (0-255). */
function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a #rrggbb color. Throws on malformed input. */
export function relativeLuminance(hex: string): number {
  if (!isValidHexColor(hex)) {
    throw new Error(`relativeLuminance: not a #rrggbb color: ${hex}`);
  }
  const v = hex.trim().slice(1);
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/**
 * Black or white — whichever contrasts more against `hex`. Falls
 * back to white on malformed input so a bad DB value degrades to
 * "readable on most colors" rather than throwing during render.
 */
export function getContrastForeground(hex: string): "#000000" | "#ffffff" {
  if (!isValidHexColor(hex)) return "#ffffff";
  // Contrast ratio against black is (L + 0.05) / 0.05; against white
  // it's 1.05 / (L + 0.05). Comparing them directly is equivalent to
  // checking whether L exceeds this fixed crossover point.
  const L = relativeLuminance(hex);
  return L > 0.179 ? "#000000" : "#ffffff";
}
