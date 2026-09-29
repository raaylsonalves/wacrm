import { brandMarkResponse } from '@/lib/brand-mark';

// iOS ignores the manifest's icons for "Add to Home Screen" and uses
// <link rel="apple-touch-icon"> instead — Next auto-injects it from
// this file. iOS applies its own rounded mask, so no corner radius.

export const runtime = 'edge';
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return brandMarkResponse(size.width, { maskable: true });
}
