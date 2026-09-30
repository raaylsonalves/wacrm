import { describe, it, expect } from 'vitest';
import { insertAtCaret, mediaKindForFile } from './composer-files';

describe('mediaKindForFile', () => {
  it.each([
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['video/mp4', 'video'],
    ['audio/ogg; codecs=opus', 'audio'],
    ['application/pdf', 'document'],
    ['text/plain', 'document'],
  ])('%s → %s', (type, kind) => expect(mediaKindForFile({ type })).toBe(kind));

  it('refuses what the bucket would refuse', () => {
    expect(mediaKindForFile({ type: 'image/gif' })).toBeNull();
    expect(mediaKindForFile({ type: 'application/zip' })).toBeNull();
    expect(mediaKindForFile({ type: '' })).toBeNull();
  });
});

describe('insertAtCaret', () => {
  it('inserts at the selection and replaces a range', () => {
    expect(insertAtCaret('oi tudo', 2, 2, '😀')).toEqual({
      value: 'oi😀 tudo',
      caret: 2 + '😀'.length,
    });
    expect(insertAtCaret('oi tudo', 3, 7, '👍')).toEqual({
      value: 'oi 👍',
      caret: 3 + '👍'.length,
    });
  });
  it('appends without a selection', () => {
    expect(insertAtCaret('oi', null, null, '!')).toEqual({
      value: 'oi!',
      caret: 3,
    });
  });
});
