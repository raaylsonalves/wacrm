/**
 * Prompt section for an AI-written follow-up (the `ai_followup` automation
 * step). The customer went quiet after our last message; the model writes
 * ONE short nudge that picks the conversation back up. Pure so the wording
 * rules — never insist, offer to stop on the last try — are unit-tested.
 */
export interface FollowupPromptArgs {
  /** 1-based: how many follow-ups this episode has had, counting this one. */
  attempt: number
  /** Last try: close the door politely and offer to stop the messages. */
  final: boolean
  /** The account's own extra guidance for this step, if any. */
  custom?: string | null
}

export function followupPromptSection(a: FollowupPromptArgs): string {
  const lines = [
    'FOLLOW-UP MODE. The customer has not answered your last message for a while and nobody is waiting on you — you are re-opening the conversation yourself.',
    'Write ONE short WhatsApp message (one or two sentences) that picks the conversation back up. Refer to the specific thing the two of you were discussing, using only what is in the conversation above — never invent details, prices or promises. Do not repeat your earlier wording.',
    'Tone: warm, light, zero pressure. Never guilt the customer, never mention that they did not reply, no "just checking in" filler, no emojis unless the conversation already uses them.',
    'Do not hand off to a human and do not output any control phrase. Output only the message text.',
  ]
  if (a.attempt <= 1) {
    lines.push(
      'This is the first follow-up: a gentle reminder of where you stopped, with one easy next step.',
    )
  } else if (!a.final) {
    lines.push(
      `This is follow-up number ${a.attempt}: earlier reminders got no answer. Be even lighter — offer help with one specific point or ask a very easy question. Do not repeat what you already asked.`,
    )
  }
  if (a.final) {
    lines.push(
      'This is the LAST follow-up. Say you do not want to bother them, that they can pick this up whenever they like, and ask whether they would prefer that you stop sending messages. Make it easy to answer with one word. Do not push the original topic.',
    )
  }
  const custom = a.custom?.trim()
  if (custom) lines.push(`Extra guidance from the business for this step: ${custom}`)
  return lines.join('\n')
}

/** The synthetic last turn: providers expect the conversation to end on the
 *  customer's side, and here it ends on ours. */
export const FOLLOWUP_USER_TURN =
  "(The customer has not replied yet. Write the business's next message now.)"
