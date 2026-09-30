/**
 * Carousel templates: read the cards out of the template Meta returned
 * (`message_templates.components`, migration 100) and build the per-send
 * `carousel` component. Pure — the whole payload contract is unit-tested,
 * since Meta answers a wrong shape only with #132012 and no field name.
 *
 * Send shape (Cloud API):
 *   { type: 'carousel', cards: [{ card_index, components: [
 *       { type: 'header', parameters: [{ type: 'image', image: { link } }] },
 *       { type: 'body', parameters: [...] },            // when the card has {{n}}
 *       { type: 'button', sub_type: 'quick_reply', index, parameters: [{ type: 'payload', payload }] },
 *       { type: 'button', sub_type: 'url', index, parameters: [{ type: 'text', text }] }, // when the URL has {{1}}
 *   ] }] }
 */

import { extractVariableIndices } from './template-validators';

interface RawComponent {
  type?: string;
  format?: string;
  text?: string;
  example?: { header_handle?: string[]; body_text?: string[][] };
  buttons?: {
    type?: string;
    text?: string;
    url?: string;
    example?: string[] | string;
  }[];
  cards?: { components?: RawComponent[] }[];
}

export interface CarouselCard {
  index: number;
  mediaType: 'image' | 'video';
  /** Meta's sample media for this card (approval-time; may expire). */
  exampleMedia: string | null;
  bodyText: string;
  /** Sample values for the card's body {{n}} — used at send time. */
  bodyExample: string[];
  buttons: {
    type: 'QUICK_REPLY' | 'URL';
    text: string;
    url?: string;
    example?: string;
  }[];
}

export function carouselCards(components: unknown): CarouselCard[] | null {
  if (!Array.isArray(components)) return null;
  const carousel = (components as RawComponent[]).find(
    (c) => (c.type ?? '').toUpperCase() === 'CAROUSEL'
  );
  if (!carousel) return null;
  return (carousel.cards ?? []).map((card, index) => {
    const parts = card.components ?? [];
    const header = parts.find((p) => (p.type ?? '').toUpperCase() === 'HEADER');
    const body = parts.find((p) => (p.type ?? '').toUpperCase() === 'BODY');
    const buttons = parts.find(
      (p) => (p.type ?? '').toUpperCase() === 'BUTTONS'
    );
    return {
      index,
      mediaType:
        (header?.format ?? '').toUpperCase() === 'VIDEO' ? 'video' : 'image',
      exampleMedia: header?.example?.header_handle?.[0] ?? null,
      bodyText: body?.text ?? '',
      bodyExample: body?.example?.body_text?.[0] ?? [],
      buttons: (buttons?.buttons ?? [])
        .filter((b) =>
          ['QUICK_REPLY', 'URL'].includes((b.type ?? '').toUpperCase())
        )
        .map((b) => ({
          type: (b.type ?? '').toUpperCase() as 'QUICK_REPLY' | 'URL',
          text: b.text ?? '',
          url: b.url,
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        })),
    };
  });
}

/** The part of a sample URL that fills `{{1}}` in a URL button. */
function urlSuffix(url: string, example: string | undefined): string | null {
  if (!example) return null;
  const prefix = url.split('{{')[0];
  return example.startsWith(prefix)
    ? example.slice(prefix.length) || null
    : example;
}

export type CarouselSendComponent = {
  type: 'carousel';
  cards: { card_index: number; components: Record<string, unknown>[] }[];
};

/**
 * Build the send-time carousel. `media[i]` is card i's link (the
 * template's saved `carousel_media`, or an override); a card without one
 * throws, naming the card — Meta would reject the whole send otherwise.
 */
export function buildCarouselComponent(
  cards: CarouselCard[],
  media: (string | null | undefined)[]
): CarouselSendComponent {
  return {
    type: 'carousel',
    cards: cards.map((card) => {
      const link = media[card.index]?.trim();
      if (!link) {
        throw new Error(
          `Carousel card ${card.index + 1} needs an ${card.mediaType} link.`
        );
      }
      const components: Record<string, unknown>[] = [
        {
          type: 'header',
          parameters: [
            card.mediaType === 'video'
              ? { type: 'video', video: { link } }
              : { type: 'image', image: { link } },
          ],
        },
      ];
      const vars = extractVariableIndices(card.bodyText).length;
      if (vars > 0) {
        if (card.bodyExample.length < vars) {
          throw new Error(
            `Carousel card ${card.index + 1} has ${vars} variable(s) without sample values.`
          );
        }
        components.push({
          type: 'body',
          parameters: card.bodyExample
            .slice(0, vars)
            .map((text) => ({ type: 'text', text })),
        });
      }
      card.buttons.forEach((b, i) => {
        if (b.type === 'QUICK_REPLY') {
          components.push({
            type: 'button',
            sub_type: 'quick_reply',
            index: String(i),
            parameters: [
              { type: 'payload', payload: `card${card.index}:${i}` },
            ],
          });
        } else if (b.url && extractVariableIndices(b.url).length > 0) {
          const suffix = urlSuffix(b.url, b.example);
          if (!suffix) {
            throw new Error(
              `Carousel card ${card.index + 1}, button ${i + 1} needs a URL value.`
            );
          }
          components.push({
            type: 'button',
            sub_type: 'url',
            index: String(i),
            parameters: [{ type: 'text', text: suffix }],
          });
        }
      });
      return { card_index: card.index, components };
    }),
  };
}

/** Media to use per card: explicit override, else saved, else Meta's sample. */
export function resolveCarouselMedia(
  cards: CarouselCard[],
  saved: unknown,
  override?: (string | null | undefined)[]
): string[] {
  const stored = Array.isArray(saved) ? (saved as unknown[]) : [];
  return cards.map((c) => {
    const o = override?.[c.index]?.trim();
    if (o) return o;
    const s = stored[c.index];
    if (typeof s === 'string' && s.trim()) return s.trim();
    return c.exampleMedia ?? '';
  });
}
