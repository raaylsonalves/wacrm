import {
  Briefcase,
  CircleSlash,
  FileText,
  GitBranch,
  Hourglass,
  List,
  MessageSquare,
  MousePointerClick,
  PencilLine,
  Sparkles,
  Tag,
  TagIcon,
  UserCheck,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { TONE_SOFT } from '@/lib/tones';
import type { AutomationStepType } from '@/types';

// ------------------------------------------------------------
// Step metadata — one source of truth for icon + label + border color
// ------------------------------------------------------------

export type StepGroup =
  'messages' | 'contact' | 'deals' | 'logic' | 'integrations';

interface StepMeta {
  label: string;
  icon: LucideIcon;
  /** Picker section and card colour. */
  group: StepGroup;
}

export const STEP_META: Record<AutomationStepType, StepMeta> = {
  send_message: {
    label: 'send_message',
    icon: MessageSquare,
    group: 'messages',
  },
  send_buttons: {
    label: 'send_buttons',
    icon: MousePointerClick,
    group: 'messages',
  },
  send_list: { label: 'send_list', icon: List, group: 'messages' },
  send_template: { label: 'send_template', icon: FileText, group: 'messages' },
  ai_followup: { label: 'ai_followup', icon: Sparkles, group: 'messages' },
  add_tag: { label: 'add_tag', icon: Tag, group: 'contact' },
  remove_tag: { label: 'remove_tag', icon: TagIcon, group: 'contact' },
  assign_conversation: {
    label: 'assign_conversation',
    icon: UserCheck,
    group: 'contact',
  },
  update_contact_field: {
    label: 'update_contact_field',
    icon: PencilLine,
    group: 'contact',
  },
  close_conversation: {
    label: 'close_conversation',
    icon: CircleSlash,
    group: 'contact',
  },
  create_deal: { label: 'create_deal', icon: Briefcase, group: 'deals' },
  wait: { label: 'wait', icon: Hourglass, group: 'logic' },
  condition: { label: 'condition', icon: GitBranch, group: 'logic' },
  send_webhook: { label: 'send_webhook', icon: Webhook, group: 'integrations' },
};

/** v2 pastel per group, so a glance at the canvas says what a step does. */
export const GROUP_TONE: Record<StepGroup, string> = {
  messages: TONE_SOFT.lilac,
  contact: TONE_SOFT.mint,
  deals: TONE_SOFT.salmon,
  logic: TONE_SOFT.blue,
  integrations: 'bg-muted text-foreground',
};

export const GROUP_ORDER: StepGroup[] = [
  'messages',
  'contact',
  'deals',
  'logic',
  'integrations',
];
