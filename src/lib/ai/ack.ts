/**
 * Recognise a message that needs no AI answer: "ok", "blz", "👍",
 * "obrigado". Every reply costs the account tokens, and answering a bare
 * acknowledgment burns them for nothing — the customer has nothing left
 * to be told.
 *
 * This only classifies the TEXT. Whether to skip is also a question about
 * the conversation (an "ok" answering "Confirma o horário?" IS the
 * answer), which `shouldSkipAcknowledgment` decides. Pure.
 *
 * Deliberately conservative: unknown words mean "not an acknowledgment"
 * and the AI answers as usual — a wrongly-skipped real question costs
 * more than a few wasted tokens.
 */

export type AckKind = 'ok' | 'thanks'

const strip = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// Pure agreement / "got it".
const OK_WORDS = new Set([
  'ok', 'okay', 'oks', 'okk', 'okok', 'blz', 'beleza', 'certo', 'certinho', 'entendi',
  'entendido', 'show', 'top', 'massa', 'joia', 'fechado', 'combinado', 'perfeito',
  'otimo', 'legal', 'sim', 'ta', 'tudo', 'bem', 'bom', 'pode', 'ser', 'de', 'acordo',
  'okey', 'vale', 'tranquilo', 'sounds', 'good', 'great', 'cool', 'got', 'it', 'sure',
  'yes', 'yep', 'alright', 'perfect', 'nice', 'entiendo', 'listo', 'vale', 'genial',
  'perfecto', 'claro', 'bueno',
])

// Thanks. A message needs at least one STRONG word; the fillers only
// modify one ("muito obrigado"), so a lone "you" or "muito" is not thanks.
const THANKS_STRONG = new Set([
  'obrigado', 'obrigada', 'obg', 'obgd', 'brigado', 'brigada', 'valeu', 'vlw', 'agradeco',
  'agradecido', 'agradecida', 'grato', 'grata', 'tmj', 'thanks', 'thank', 'thx', 'ty', 'gracias',
])
const THANKS_FILL = new Set(['muito', 'muchas', 'mto', 'demais', 'so', 'much', 'very', 'you'])

// Emoji that only ever say "fine / thanks". An allow-list on purpose: 😡 or
// ❓ must never be swallowed.
const OK_EMOJI = new Set([
  '👍', '👌', '🙏', '😊', '😀', '😁', '😄', '😉', '🙂', '🤝', '👏', '🙌', '✅', '✔',
  '❤', '♥', '🥰', '😍', '💙', '💚', '💛', '🧡', '💜', '🤗', '😌', '🤙', '💪', '🫡',
])

/** A message of only allow-listed emoji ("👍", "🙏🙏", "👍🏽"). */
function isOnlyOkEmoji(text: string): boolean {
  const cleaned = text.replace(/[\s‍️]/g, '').replace(/[\u{1f3fb}-\u{1f3ff}]/gu, '')
  if (!cleaned) return false
  const chars = [...cleaned]
  return chars.length <= 6 && chars.every((c) => OK_EMOJI.has(c))
}

export function classifyAcknowledgment(text: string): AckKind | null {
  const raw = text.trim()
  if (!raw || raw.length > 40) return null
  // A question or a request is never a bare acknowledgment.
  if (/[?¿]/.test(raw)) return null

  if (isOnlyOkEmoji(raw)) return 'ok'

  // Words, ignoring any trailing emoji ("ok 👍", "obrigado 🙏").
  const words = strip(raw.replace(/\p{Extended_Pictographic}/gu, ' ')).split(' ').filter(Boolean)
  if (words.length === 0 || words.length > 5) return null

  let thanks = false
  let matched = false
  for (const w of words) {
    if (THANKS_STRONG.has(w)) {
      thanks = true
      matched = true
    } else if (OK_WORDS.has(w)) {
      matched = true
    } else if (!THANKS_FILL.has(w)) {
      return null
    }
  }
  // Fillers alone ("muito", "you") say nothing.
  if (!matched) return null
  return thanks ? 'thanks' : 'ok'
}

/**
 * Skip only when the customer has nothing left to be told:
 *  - the text is an acknowledgment, and
 *  - the AI already replied in this conversation (a first "ok" still gets
 *    a greeting), and
 *  - the last thing the business sent asked nothing: no "?" and not an
 *    interactive prompt (a button/list awaiting a tap).
 */
export function shouldSkipAcknowledgment(args: {
  text: string
  aiReplyCount: number
  lastBusinessMessage: { contentType: string | null; text: string | null } | null
}): AckKind | null {
  const kind = classifyAcknowledgment(args.text)
  if (!kind) return null
  if (args.aiReplyCount < 1) return null
  const last = args.lastBusinessMessage
  if (!last) return null
  if (last.contentType === 'interactive') return null
  if (last.text && /[?¿]/.test(last.text)) return null
  return kind
}
