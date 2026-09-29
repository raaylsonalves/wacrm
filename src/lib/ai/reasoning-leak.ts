/**
 * Keep a model's private reasoning out of the customer's chat.
 *
 * Some models — free-tier reasoning models routed through OpenRouter in
 * particular — return their chain of thought inside the assistant text
 * ("Okay, let me break this down. The user is ... According to the
 * guidelines I should ..."), and the auto-reply sent it to the customer
 * verbatim. Two layers, both pure:
 *
 *  1. `stripThinkBlocks` removes explicit <think>…</think> (and
 *     <thinking>, <reasoning>) blocks, including an unclosed one.
 *  2. `looksLikeReasoningLeak` catches the untagged case: the text opens
 *     like a monologue AND talks about the conversation from outside
 *     ("the user", "the guidelines", "my next message"). Two signals are
 *     required so an ordinary reply that merely starts with "Okay," is
 *     never dropped. A leak is treated like an empty reply, which hands
 *     the conversation to a person instead of sending it.
 */

const THINK_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi
const UNCLOSED_THINK = /<(think|thinking|reasoning)>[\s\S]*$/i

export function stripThinkBlocks(text: string): string {
  return text.replace(THINK_BLOCK, '').replace(UNCLOSED_THINK, '').trim()
}

// How a monologue starts, in the languages the product ships in.
const MONOLOGUE_OPENER =
  /^\s*(?:okay|ok|alright|hmm+|wait|let me|let's|first,? i|so,? the user|the user (?:is|has|wants|said|says|asked)|ok,? |certo,? (?:o|a) (?:usu[aá]rio|cliente)|vamos (?:analisar|ver)|deixa eu|o (?:usu[aá]rio|cliente) (?:est[aá]|quer|disse|perguntou))/i

// Talking ABOUT the chat rather than TO the customer.
const OUTSIDE_VIEW = [
  /\bthe user\b/i,
  /\bthe customer (?:is|has|said|wants|asked)\b/i,
  /\b(?:the )?(?:guidelines?|system prompt|instructions?|business context)\b[^.\n]{0,40}\b(?:say|says|state|require|tell)/i,
  /\bmy (?:next|reply|response|message)\b/i,
  /\bI (?:need|should|must|have) to (?:ask|confirm|handoff|hand off|make sure|check)\b/i,
  /\b(?:o|do) usu[aá]rio\b/i,
  /\bminha (?:pr[oó]xima )?(?:resposta|mensagem)\b/i,
  /\bhandoff\b/i,
]

export function looksLikeReasoningLeak(text: string): boolean {
  const head = text.slice(0, 400)
  if (!MONOLOGUE_OPENER.test(head)) return false
  let signals = 0
  for (const re of OUTSIDE_VIEW) if (re.test(text)) signals++
  return signals >= 2
}
