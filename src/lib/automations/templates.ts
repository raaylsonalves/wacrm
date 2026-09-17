import type {
  AutomationStepConfig,
  AutomationStepType,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/types'

export type TemplateSlug =
  | 'welcome_message'
  | 'out_of_office'
  | 'lead_qualifier'
  | 'follow_up_reminder'

export interface TemplateStepSeed {
  step_type: AutomationStepType
  step_config: AutomationStepConfig
  branch?: 'yes' | 'no' | null
  /** Index (within this seed list) of the Condition parent, if nested. */
  parent_index?: number | null
}

export interface AutomationTemplateDefinition {
  slug: TemplateSlug
  /** English fallback — real display text comes from
   *  `resolveAutomationTemplate` via `messages/*.json`'s
   *  `Automations.templates.<slug>.name`. Kept here only so a caller
   *  that skips resolution (there shouldn't be one) fails safe. */
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: AutomationTriggerConfig
  steps: TemplateStepSeed[]
}

/**
 * The only `send_message` step in each template — the one whose
 * `step_config.text` gets swapped for the locale's translated copy in
 * `resolveAutomationTemplate`. Cloning a template used to seed an
 * English greeting/pitch regardless of NEXT_PUBLIC_APP_LOCALE, shipping
 * English straight to a Brazilian (or Spanish/Korean) customer the
 * first time they messaged in.
 */
const TEMPLATE_TEXT_STEP_INDEX: Record<TemplateSlug, number> = {
  welcome_message: 0,
  out_of_office: 1,
  lead_qualifier: 0,
  follow_up_reminder: 1,
}

export const AUTOMATION_TEMPLATES: Record<TemplateSlug, AutomationTemplateDefinition> = {
  welcome_message: {
    slug: 'welcome_message',
    name: 'Welcome Message',
    description: 'Auto-reply to first-time contacts with a greeting.',
    // first_inbound_message (added in PR #33) catches both brand-new
    // contacts AND manually-added/imported contacts on their first-ever
    // reply, which is what a user setting up a "welcome" automation
    // almost always wants. new_contact_created would miss the
    // manually-imported case.
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.",
        },
      },
      {
        step_type: 'add_tag',
        step_config: { tag_id: '' },
      },
    ],
  },
  out_of_office: {
    slug: 'out_of_office',
    name: 'Out of Office',
    description: 'Auto-reply during off-hours so nobody is left waiting.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'condition',
        step_config: {
          subject: 'time_of_day',
          operand: '18:00-09:00',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.",
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  lead_qualifier: {
    slug: 'lead_qualifier',
    name: 'Lead Qualifier',
    description: 'Ask qualification questions to filter inbound leads.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['pricing', 'quote', 'buy'],
      match_type: 'contains',
    },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?",
        },
      },
      {
        step_type: 'wait',
        step_config: { amount: 10, unit: 'minutes' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  follow_up_reminder: {
    slug: 'follow_up_reminder',
    name: 'Follow-up Reminder',
    description: 'Send a nudge if a contact has not replied within 24 hours.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Just circling back — did you have any other questions for us? Happy to help!",
        },
      },
    ],
  },
}

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null
}

/**
 * Resolve a template's display name/description and its one
 * translatable message body through `t`, a lookup scoped to
 * `Automations.templates.<slug>` (i.e. `t('name')`, not
 * `t('welcome_message.name')`). Every caller that shows a template to
 * a user or seeds an automation from one MUST go through this —
 * reading `AUTOMATION_TEMPLATES[slug]` directly gets the English
 * fallback regardless of locale.
 */
export function resolveAutomationTemplate(
  slug: TemplateSlug,
  t: (key: 'name' | 'description' | 'text') => string,
): AutomationTemplateDefinition {
  const def = AUTOMATION_TEMPLATES[slug]
  const textStepIndex = TEMPLATE_TEXT_STEP_INDEX[slug]
  return {
    ...def,
    name: t('name'),
    description: t('description'),
    steps: def.steps.map((step, i) =>
      i === textStepIndex
        ? { ...step, step_config: { ...step.step_config, text: t('text') } }
        : step,
    ),
  }
}

/**
 * Server-side counterpart to `useTranslations` for the one non-React
 * caller: POST /api/automations' `template` shortcut, which seeds an
 * automation straight from `{ template: slug }` with no client-side
 * builder in between. Mirrors src/i18n/request.ts's own locale-file
 * resolution (same env var, same fallback-to-en) rather than pulling in
 * next-intl/server's request-scoped context for one lookup.
 */
export async function loadServerTemplateTranslator(
  slug: TemplateSlug,
): Promise<(key: 'name' | 'description' | 'text') => string> {
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'en'
  let messages: Record<string, unknown>
  try {
    messages = (await import(`../../../messages/${locale}.json`)).default
  } catch {
    messages = (await import(`../../../messages/en.json`)).default
  }
  const scoped =
    ((messages.Automations as Record<string, unknown> | undefined)
      ?.templates as Record<string, Record<string, string>> | undefined)?.[slug] ?? {}
  // Defensive fallback only — en.json (loaded above when the app
  // locale's own file is missing a key) should always carry these.
  return (key) => scoped[key] ?? key
}
