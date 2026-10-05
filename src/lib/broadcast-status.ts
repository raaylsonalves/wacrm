/**
 * Shared status badge config for broadcasts + recipients.
 *
 * Previously `statusConfig` was defined inline in both
 * /broadcasts/page.tsx and /broadcasts/[id]/page.tsx with slight
 * drift risk. One source of truth now.
 *
 * Badge shape: the v2 pastel tones (bg-tone-*-soft + text-tone-*-ink),
 * which carry their own light/dark values; neutral statuses use the
 * muted pair. The border stays transparent so callers that add a
 * `border` class keep their size without drawing a line.
 */

import type { BroadcastStatus, RecipientStatus } from "@/types";

export interface StatusDisplay {
  label: string;
  classes: string;
  /**
   * Set true for statuses that should pulse in the UI to convey
   * "live / in-flight" — currently only `sending`.
   */
  pulse?: boolean;
}

export const broadcastStatusConfig: Record<BroadcastStatus, StatusDisplay> = {
  draft: {
    label: "draft",
    classes: "bg-muted text-muted-foreground border-transparent",
  },
  scheduled: {
    label: "scheduled",
    classes: "bg-tone-blue-soft text-tone-blue-ink border-transparent",
  },
  sending: {
    label: "sending",
    classes: "bg-tone-salmon-soft text-tone-salmon-ink border-transparent",
    pulse: true,
  },
  sent: {
    label: "sent",
    classes: "bg-tone-mint-soft text-tone-mint-ink border-transparent",
  },
  failed: {
    label: "failed",
    classes: "bg-tone-pink-soft text-tone-pink-ink border-transparent",
  },
  cancelled: {
    label: "cancelled",
    classes: "bg-muted text-muted-foreground border-transparent",
  },
};

export const recipientStatusConfig: Record<RecipientStatus, StatusDisplay> = {
  pending: {
    label: "pending",
    classes: "bg-muted text-muted-foreground border-transparent",
  },
  sent: {
    label: "sent",
    classes: "bg-tone-blue-soft text-tone-blue-ink border-transparent",
  },
  delivered: {
    label: "delivered",
    classes: "bg-tone-mint-soft text-tone-mint-ink border-transparent",
  },
  read: {
    label: "read",
    classes: "bg-tone-mint-soft text-tone-mint-ink border-transparent",
  },
  replied: {
    label: "replied",
    classes: "bg-tone-lilac-soft text-tone-lilac-ink border-transparent",
  },
  failed: {
    label: "failed",
    classes: "bg-tone-pink-soft text-tone-pink-ink border-transparent",
  },
};

/**
 * Tolerant lookup — callers often have a generic string status
 * coming from Supabase. Falls back to the "draft" / "pending"
 * entry so the UI never crashes on an unknown value.
 */
export function getBroadcastStatus(status: string): StatusDisplay {
  return (
    broadcastStatusConfig[status as BroadcastStatus] ??
    broadcastStatusConfig.draft
  );
}

export function getRecipientStatus(status: string): StatusDisplay {
  return (
    recipientStatusConfig[status as RecipientStatus] ??
    recipientStatusConfig.pending
  );
}
