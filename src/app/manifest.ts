import type { MetadataRoute } from 'next';

import { buildManifest } from '@/lib/pwa';

// Next serves this at /manifest.webmanifest and auto-links it in <head>.
export default function manifest(): MetadataRoute.Manifest {
  return buildManifest();
}
