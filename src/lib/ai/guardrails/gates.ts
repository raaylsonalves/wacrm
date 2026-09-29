/**
 * Before-send checks on what the AI is about to say
 * (specs/ai-output-guardrails.md). Pure and synchronous: each gate looks
 * at the joined reply text and a small context and returns a verdict.
 *
 * The ORDER is the contract — `BEFORE_SEND_GATES` is locked by a test so
 * changing the chain turns CI red first. Opt-out stays first: it is the
 * one that must never be skipped.
 *
 * Calibrated for FEW false positives: a wrongly-blocked good reply costs
 * a needless handoff. Each regex has fixtures for the sentence it must
 * NOT catch. Business words ("etapa", "funil") are never matched — only
 * identifier shapes.
 */
import { looksLikeReasoningLeak } from '../reasoning-leak'

export const BEFORE_SEND_CHAIN_VERSION = 1

export const BEFORE_SEND_GATES = [
  'opt_out',
  'reasoning_leak',
  'human_promise',
  'internal_vocabulary',
] as const

export type GateName = (typeof BEFORE_SEND_GATES)[number]

export interface GateContext {
  /** contacts.opted_out_at is set. */
  optedOut: boolean
  /** The turn is already handing off (sentinel seen): promising a human is then true. */
  handingOff: boolean
}

export type GateVerdict =
  | { pass: true }
  | { pass: false; code: string; reason: string }

const PASS: GateVerdict = { pass: true }

// "vou encaminhar / passar para o time", "nossa equipe vai retornar"…
// A promise = future action by a human. "está sempre à disposição" is
// institutional and "verificar no sistema" is not a human — neither matches.
const HUMAN_PROMISE = [
  /\b(?:vou|irei|vamos)\s+(?:te\s+|lhe\s+)?(?:encaminhar|passar|transferir|repassar)\b[^.\n]{0,40}\b(?:time|equipe|atendente|humano|especialista|consultor|respons[aá]vel)/i,
  /\b(?:nossa\s+equipe|nosso\s+time|um\s+atendente|um\s+consultor|um\s+especialista|algu[eé]m\s+(?:da|do)\s+(?:equipe|time))\s+(?:vai|ir[aá]|entrar[aá]|retornar[aá]|te\s+(?:chamar|responder|retornar))/i,
  /\b(?:i(?:'ll| will)|we(?:'ll| will))\s+(?:pass|forward|transfer|hand)\b[^.\n]{0,30}\b(?:team|human|agent|specialist)/i,
  /\b(?:our team|a (?:human|team member|specialist))\s+(?:will|is going to)\s+(?:contact|reach|get back|follow)/i,
  /\b(?:voy a|vamos a)\s+(?:pasar|derivar|transferir)\b[^.\n]{0,30}\b(?:equipo|humano|agente)/i,
]

// Identifier shapes that only exist inside the system.
const INTERNAL_VOCAB = [
  /\b(?:crm|ai|whatsapp)_[a-z]+(?:_[a-z]+)+\b/, // snake_case tool/table names
  /\b(?:book_appointment|offer_slots|check_availability|cancel_appointment)\b/,
  /\b(?:supabase|postgres(?:ql)?|service[_ -]role|row level security)\b/i,
  /\bRole '[a-z_]+' (?:insufficient|is not)/i,
  /\b(?:MetaApiError|AiError|TypeError|ReferenceError|Unhandled(?:Promise)?Rejection)\b/,
  /\bat [\w.$<>]+ \([^)\n]*:\d+:\d+\)/, // stack frame
  /\b(?:HANDOFF|__HANDOFF__|<<HANDOFF)/, // leaked control sentinel
  /\bapi[_ -]?key\b.{0,20}\b(?:sk-|AIza)/i,
]

const GATES: Record<GateName, (text: string, ctx: GateContext) => GateVerdict> = {
  opt_out: (_t, ctx) =>
    ctx.optedOut
      ? {
          pass: false,
          code: 'contact_opted_out',
          reason: 'The contact opted out; the assistant must not message them.',
        }
      : PASS,

  reasoning_leak: (text) =>
    looksLikeReasoningLeak(text)
      ? {
          pass: false,
          code: 'reasoning_leak',
          reason: 'The text is the model thinking out loud, not a message to the customer.',
        }
      : PASS,

  human_promise: (text, ctx) => {
    if (ctx.handingOff) return PASS
    return HUMAN_PROMISE.some((re) => re.test(text))
      ? {
          pass: false,
          code: 'human_promised_without_handoff',
          reason:
            'The reply promises a person will follow up, but no handoff was made. Use the handoff instead of saying it.',
        }
      : PASS
  },

  internal_vocabulary: (text) =>
    INTERNAL_VOCAB.some((re) => re.test(text))
      ? {
          pass: false,
          code: 'internal_identifier',
          reason: 'The reply exposes an internal identifier or error to the customer.',
        }
      : PASS,
}

export interface Veto {
  gate: GateName
  code: string
  reason: string
}

/**
 * Run the chain on the JOINED reply text (never per bubble). Stops at the
 * first veto. Returns the veto, or null when every gate passes.
 */
export function runBeforeSend(text: string, ctx: GateContext): Veto | null {
  for (const gate of BEFORE_SEND_GATES) {
    const v = GATES[gate](text, ctx)
    if (!v.pass) return { gate, code: v.code, reason: v.reason }
  }
  return null
}
