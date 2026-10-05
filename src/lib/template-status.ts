/**
 * Shared display config for message_templates.status.
 *
 * The DB stores Meta's raw enum (DRAFT / APPROVED / PENDING / REJECTED /
 * PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION) — the UI maps it to
 * a translation key (`TemplateStatus.<KEY>`) + v2 tone badge classes here so the template manager,
 * inbox picker, and broadcast picker stay aligned.
 */

import type { MessageTemplateStatus } from '@/types';

export interface TemplateStatusDisplay {
  label: string;
  classes: string;
}

export const templateStatusConfig: Record<
  MessageTemplateStatus,
  TemplateStatusDisplay
> = {
  DRAFT: {
    label: 'Draft',
    classes: 'bg-muted text-muted-foreground border-transparent',
  },
  PENDING: {
    label: 'Pending',
    classes: 'bg-tone-salmon-soft text-tone-salmon-ink border-transparent',
  },
  APPROVED: {
    label: 'Approved',
    classes: 'bg-tone-mint-soft text-tone-mint-ink border-transparent',
  },
  REJECTED: {
    label: 'Rejected',
    classes: 'bg-tone-pink-soft text-tone-pink-ink border-transparent',
  },
  PAUSED: {
    label: 'Paused',
    classes: 'bg-tone-salmon-soft text-tone-salmon-ink border-transparent',
  },
  DISABLED: {
    label: 'Disabled',
    classes: 'bg-tone-pink-soft text-tone-pink-ink border-transparent',
  },
  IN_APPEAL: {
    label: 'In Appeal',
    classes: 'bg-tone-blue-soft text-tone-blue-ink border-transparent',
  },
  PENDING_DELETION: {
    label: 'Pending Deletion',
    classes: 'bg-muted text-muted-foreground border-transparent',
  },
};
