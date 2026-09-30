/**
 * "Resumo e próximo passo" — the prompt section and the parser for the
 * conversation summary card. Pure so the output contract is unit-tested:
 * models wrap, reorder or translate headings, and the card must still get
 * two clean strings.
 */
export interface ConversationSummary {
  summary: string;
  next_step: string;
}

export function summaryPromptSection(): string {
  return [
    'SUMMARY MODE. You are not replying to the customer. You are briefing the human teammate who is about to open this conversation.',
    'Write in the language the conversation is in. Use ONLY facts in the conversation above — never invent names, values, dates or promises.',
    'Reply in exactly this format, nothing before or after:',
    'RESUMO:',
    '<2 to 4 short sentences: who the customer is, what they want, what was already answered or agreed, and anything still open>',
    'PROXIMO_PASSO:',
    '<one concrete next action for the team, starting with a verb (e.g. "Enviar a simulação de 24x e confirmar o CPF"). If nothing is needed, say so in one short sentence.>',
  ].join('\n');
}

/** Turn the model's two-section answer into the card's two strings. */
export function parseSummary(raw: string): ConversationSummary | null {
  const text = raw.replace(/\r/g, '').trim();
  const re =
    /(?:^|\n)\s*\**\s*(RESUMO|SUMMARY|PR[OÓ]XIMO[ _]PASSO|NEXT[ _]STEP)\s*\**\s*:?\s*\**\s*\n?/gi;
  const marks: { key: 'summary' | 'next'; start: number; end: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const word = m[1].toUpperCase();
    marks.push({
      key: word.startsWith('RESUMO') || word === 'SUMMARY' ? 'summary' : 'next',
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  const pick = (key: 'summary' | 'next'): string => {
    const i = marks.findIndex((x) => x.key === key);
    if (i < 0) return '';
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    return text.slice(marks[i].end, end).trim();
  };
  const summary = pick('summary');
  const next_step = pick('next');
  if (!summary) return null;
  return { summary, next_step };
}
