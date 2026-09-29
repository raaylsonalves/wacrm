/**
 * Split a reply that is too long for one WhatsApp message.
 *
 * Meta rejects a text body over 4096 characters ("Param text.body must be
 * at most 4096 characters long") and the whole reply is lost — seen in
 * production with a 4,402-character answer from a free model that ignored
 * the "short messages" instruction. The prompt asks the model to be brief;
 * this is the backstop that doesn't depend on it obeying.
 *
 * The default is 4000, not 4096: a margin, because the limit is Meta's to
 * define and counts characters its own way.
 *
 * Cuts at the most natural boundary that still leaves the chunk
 * reasonably full — paragraph, then line, then sentence, then word —
 * and only hard-cuts a run with no boundary at all (a pasted URL, say).
 * Never splits a surrogate pair. Pure.
 */

export const WHATSAPP_TEXT_LIMIT = 4000

export function splitLongText(text: string, max: number = WHATSAPP_TEXT_LIMIT): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed ? [trimmed] : []

  const out: string[] = []
  let rest = trimmed
  while (rest.length > max) {
    const cut = pickCut(rest, max)
    const piece = rest.slice(0, cut).trim()
    if (piece) out.push(piece)
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

/** Where to cut `rest` (longer than `max`). Prefers a boundary in the
 *  back half of the window so chunks don't shrink to a few characters. */
function pickCut(rest: string, max: number): number {
  const window = rest.slice(0, max)
  const floor = Math.floor(max / 2)

  const paragraph = window.lastIndexOf('\n\n')
  if (paragraph >= floor) return paragraph
  const line = window.lastIndexOf('\n')
  if (line >= floor) return line

  // Sentence end: . ! ? followed by whitespace.
  let sentence = -1
  const re = /[.!?…]["')\]]?\s/g
  for (let m = re.exec(window); m; m = re.exec(window)) sentence = m.index + m[0].length
  if (sentence >= floor) return sentence

  const space = window.lastIndexOf(' ')
  if (space >= floor) return space

  // No boundary at all: hard cut, but never between the halves of a
  // surrogate pair (an emoji).
  const code = window.charCodeAt(max - 1)
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max
}
