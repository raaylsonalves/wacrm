import { describe, it, expect } from 'vitest';
import {
  isTypingTarget,
  neighborId,
  resolveInboxShortcut,
} from './use-inbox-shortcuts';

const body = { tagName: 'BODY', closest: () => null };

describe('resolveInboxShortcut', () => {
  it('maps j/k and arrows to next/prev', () => {
    expect(resolveInboxShortcut({ key: 'j', target: body })).toBe('next');
    expect(resolveInboxShortcut({ key: 'ArrowDown', target: body })).toBe(
      'next'
    );
    expect(resolveInboxShortcut({ key: 'k', target: body })).toBe('prev');
    expect(resolveInboxShortcut({ key: 'ArrowUp', target: body })).toBe('prev');
  });

  it('maps e / r / s / ?', () => {
    expect(resolveInboxShortcut({ key: 'e', target: body })).toBe('close');
    expect(resolveInboxShortcut({ key: 'r', target: body })).toBe('reply');
    expect(resolveInboxShortcut({ key: 's', target: body })).toBe('snooze');
    expect(resolveInboxShortcut({ key: '?', target: body })).toBe('help');
  });

  it('never fires while typing in the composer or any input', () => {
    for (const tagName of ['TEXTAREA', 'INPUT', 'SELECT']) {
      expect(
        resolveInboxShortcut({ key: 'j', target: { tagName } })
      ).toBeNull();
    }
    expect(
      resolveInboxShortcut({
        key: 'e',
        target: { tagName: 'DIV', isContentEditable: true },
      })
    ).toBeNull();
  });

  it('ignores IME composition and modifier combos', () => {
    expect(
      resolveInboxShortcut({ key: 'j', isComposing: true, target: body })
    ).toBeNull();
    expect(
      resolveInboxShortcut({ key: 'r', ctrlKey: true, target: body })
    ).toBeNull();
    expect(
      resolveInboxShortcut({ key: 'r', metaKey: true, target: body })
    ).toBeNull();
  });

  it('ignores unmapped keys', () => {
    expect(resolveInboxShortcut({ key: 'x', target: body })).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('treats anything inside an open menu or dialog as off-limits', () => {
    const inMenu = { tagName: 'DIV', closest: () => ({}) };
    expect(isTypingTarget(inMenu)).toBe(true);
    expect(isTypingTarget(body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('neighborId', () => {
  const ids = ['a', 'b', 'c'];
  it('steps and clamps at the ends', () => {
    expect(neighborId(ids, 'a', 1)).toBe('b');
    expect(neighborId(ids, 'c', 1)).toBe('c');
    expect(neighborId(ids, 'a', -1)).toBe('a');
  });
  it('starts at top (next) or bottom (prev) with nothing active', () => {
    expect(neighborId(ids, null, 1)).toBe('a');
    expect(neighborId(ids, null, -1)).toBe('c');
    expect(neighborId(ids, 'gone', 1)).toBe('a');
  });
  it('returns null for an empty list', () => {
    expect(neighborId([], null, 1)).toBeNull();
  });
});
