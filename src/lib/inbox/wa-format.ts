/**
 * WhatsApp's inline formatting — *bold*, _italic_, ~strike~, ```mono``` —
 * parsed into segments so the inbox shows a message the way the phone
 * does instead of with the raw markers. Same rule as WhatsApp: a marker
 * only opens next to a non-space character and closes before one, and it
 * never spans a line break, so "5 * 3 = 15" or a lone "_" stays literal.
 */

export interface WaSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  mono?: boolean;
}

const MARKS: { re: RegExp; key: keyof Omit<WaSegment, 'text'> }[] = [
  { re: /```([^`]+?)```/, key: 'mono' },
  { re: /(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/, key: 'bold' },
  { re: /(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/, key: 'italic' },
  { re: /(?<![\w~])~(?=\S)([^~\n]*?\S)~(?![\w~])/, key: 'strike' },
];

function parse(text: string, style: Omit<WaSegment, 'text'>): WaSegment[] {
  if (!text) return [];
  // Earliest marker wins; the inside is parsed again for nested styles.
  let best: {
    index: number;
    length: number;
    inner: string;
    key: keyof Omit<WaSegment, 'text'>;
  } | null = null;
  for (const { re, key } of MARKS) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, length: m[0].length, inner: m[1], key };
    }
  }
  if (!best) return [{ text, ...style }];
  const inner =
    best.key === 'mono'
      ? [{ text: best.inner, ...style, mono: true }]
      : parse(best.inner, { ...style, [best.key]: true });
  return [
    ...(best.index > 0 ? [{ text: text.slice(0, best.index), ...style }] : []),
    ...inner,
    ...parse(text.slice(best.index + best.length), style),
  ];
}

export function parseWhatsAppFormat(text: string): WaSegment[] {
  return parse(text, {});
}
