import { describe, it, expect } from 'vitest';
import {
  buildCarouselComponent,
  carouselCards,
  resolveCarouselMedia,
} from './template-carousel';

// Shape Meta returns on GET /message_templates for a media carousel.
const components = [
  { type: 'BODY', text: 'Our in-house chefs have prepared recipes.' },
  {
    type: 'CAROUSEL',
    cards: [
      {
        components: [
          {
            type: 'HEADER',
            format: 'IMAGE',
            example: { header_handle: ['https://cdn/a.jpg'] },
          },
          { type: 'BODY', text: 'Salad' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'Send more' },
              {
                type: 'URL',
                text: 'Shop',
                url: 'https://shop.x/{{1}}',
                example: ['https://shop.x/salad'],
              },
            ],
          },
        ],
      },
      {
        components: [
          {
            type: 'HEADER',
            format: 'VIDEO',
            example: { header_handle: ['https://cdn/b.mp4'] },
          },
          {
            type: 'BODY',
            text: 'Soup for {{1}}',
            example: { body_text: [['two']] },
          },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'URL', text: 'Site', url: 'https://x.com' }],
          },
        ],
      },
    ],
  },
];

describe('carouselCards', () => {
  it('reads each card', () => {
    const cards = carouselCards(components)!;
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      index: 0,
      mediaType: 'image',
      exampleMedia: 'https://cdn/a.jpg',
    });
    expect(cards[1]).toMatchObject({
      mediaType: 'video',
      bodyExample: ['two'],
    });
    expect(cards[0].buttons.map((b) => b.type)).toEqual(['QUICK_REPLY', 'URL']);
  });

  it('is null for a template without a carousel', () => {
    expect(carouselCards([{ type: 'BODY', text: 'hi' }])).toBeNull();
    expect(carouselCards(null)).toBeNull();
  });
});

describe('buildCarouselComponent', () => {
  const cards = carouselCards(components)!;

  it('builds the send payload Meta expects', () => {
    expect(
      buildCarouselComponent(cards, ['https://m/1.jpg', 'https://m/2.mp4'])
    ).toEqual({
      type: 'carousel',
      cards: [
        {
          card_index: 0,
          components: [
            {
              type: 'header',
              parameters: [
                { type: 'image', image: { link: 'https://m/1.jpg' } },
              ],
            },
            {
              type: 'button',
              sub_type: 'quick_reply',
              index: '0',
              parameters: [{ type: 'payload', payload: 'card0:0' }],
            },
            {
              type: 'button',
              sub_type: 'url',
              index: '1',
              parameters: [{ type: 'text', text: 'salad' }],
            },
          ],
        },
        {
          card_index: 1,
          components: [
            {
              type: 'header',
              parameters: [
                { type: 'video', video: { link: 'https://m/2.mp4' } },
              ],
            },
            { type: 'body', parameters: [{ type: 'text', text: 'two' }] },
          ],
        },
      ],
    });
  });

  it('names the card that has no media', () => {
    expect(() =>
      buildCarouselComponent(cards, ['https://m/1.jpg', ''])
    ).toThrow('card 2');
  });
});

describe('resolveCarouselMedia', () => {
  const cards = carouselCards(components)!;
  it('prefers the override, then the saved link, then Meta sample', () => {
    expect(
      resolveCarouselMedia(
        cards,
        ['https://saved/1.jpg'],
        [undefined, 'https://o/2.mp4']
      )
    ).toEqual(['https://saved/1.jpg', 'https://o/2.mp4']);
    expect(resolveCarouselMedia(cards, null)).toEqual([
      'https://cdn/a.jpg',
      'https://cdn/b.mp4',
    ]);
  });
});
