import { brandMarkResponse } from "@/lib/brand-mark";

// Replaces the default Next.js favicon with the brand mark (see
// src/lib/brand-mark.tsx). Next.js renders this at build time and
// auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return brandMarkResponse(size.width);
}
