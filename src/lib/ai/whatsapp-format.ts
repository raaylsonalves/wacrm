/**
 * Models write Markdown; WhatsApp is not Markdown. `**bold**` shows up
 * with the asterisks (WhatsApp bold is a single `*`), `# Title` shows a
 * hash, and a speech engine may read the symbols out loud. Pure.
 */

/** Markdown → WhatsApp's own formatting. */
export function toWhatsAppFormat(text: string): string {
  return (
    text
      // Code fences: keep the content, drop the fence lines.
      .replace(/^```[^\n]*\n?/gm, '')
      // **bold** / __bold__ → *bold*
      .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '*$1*')
      .replace(/__(?=\S)([^_\n]+?)__/g, '*$1*')
      // ~~strike~~ → ~strike~
      .replace(/~~(?=\S)([^~\n]+?)~~/g, '~$1~')
      // # Heading → *Heading*
      .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '*$1*')
      // [label](https://…) → label: https://…
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2')
      // "* item" bullets → "• item" (a leading * would open bold)
      .replace(/^([ \t]*)[*+][ \t]+/gm, '$1• ')
  )
}

/** Text for text-to-speech: no formatting symbols, links reduced to the
 *  label, bullets to plain lines. */
export function toSpeechText(text: string): string {
  return toWhatsAppFormat(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/^[ \t]*[•-][ \t]+/gm, '')
    .replace(/:\s*$/gm, ':')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}
