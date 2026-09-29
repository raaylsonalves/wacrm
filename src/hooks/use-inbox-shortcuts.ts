'use client';

import { useEffect, useRef } from 'react';

// Inbox keyboard shortcuts (specs/inbox-power-features.md). Pure helpers
// first so the key mapping and "am I typing?" guard are unit-tested
// without a DOM.

export type InboxShortcut =
  'next' | 'prev' | 'close' | 'reply' | 'snooze' | 'help';

const KEY_MAP: Record<string, InboxShortcut> = {
  j: 'next',
  ArrowDown: 'next',
  k: 'prev',
  ArrowUp: 'prev',
  e: 'close',
  r: 'reply',
  s: 'snooze',
  '?': 'help',
};

/** Structural subset of an EventTarget, so tests needn't build a DOM. */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/**
 * True when focus is somewhere the user types, or inside an open
 * menu/dialog — a shortcut must never steal those keystrokes (arrows
 * navigate menus; letters go into inputs).
 */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (target.closest?.('[role="menu"], [role="dialog"], [role="listbox"]')) {
    return true;
  }
  return false;
}

export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  target: TargetLike | null;
}

export function resolveInboxShortcut(e: KeyEventLike): InboxShortcut | null {
  // IME composition (same guard the composer's Enter-to-send uses) and
  // any modifier combo belong to the browser/OS, not us.
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  return KEY_MAP[e.key] ?? null;
}

/**
 * The id `dir` steps away from `activeId` in `ids`, clamped at the
 * ends. With nothing active, "next" starts at the top and "prev" at
 * the bottom.
 */
export function neighborId(
  ids: string[],
  activeId: string | null,
  dir: 1 | -1
): string | null {
  if (ids.length === 0) return null;
  const idx = activeId ? ids.indexOf(activeId) : -1;
  if (idx === -1) return dir === 1 ? ids[0] : ids[ids.length - 1];
  const next = Math.min(ids.length - 1, Math.max(0, idx + dir));
  return ids[next];
}

/** One window keydown listener; handlers read through a ref so the
 *  listener is attached once rather than on every render. */
export function useInboxShortcuts(
  handlers: Partial<Record<InboxShortcut, () => void>>,
  enabled = true
) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const shortcut = resolveInboxShortcut({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        isComposing: e.isComposing,
        target: e.target as TargetLike | null,
      });
      if (!shortcut) return;
      const handler = ref.current[shortcut];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
