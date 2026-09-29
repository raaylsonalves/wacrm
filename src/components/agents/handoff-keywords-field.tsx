'use client';

import { useTranslations } from 'next-intl';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  SUGGESTED_HANDOFF_KEYWORDS,
  cleanHandoffKeywords,
} from '@/lib/ai/handoff-keywords';

/**
 * "Hand off to a person" phrases, one per line
 * (specs/ai-agents-management.md §4). A match sends the conversation to a
 * human BEFORE any model call — no tokens, no model discretion — and the
 * customer is told a person is coming. The text is kept as the user types
 * it (so a trailing newline works); `toList` cleans it on save.
 */
export function HandoffKeywordsField({
  value,
  onChange,
  disabled,
}: {
  /** The raw textarea text. */
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Agents.detail.keywords');
  const count = cleanHandoffKeywords(value.split('\n')).length;

  return (
    <div className="space-y-1.5">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        disabled={disabled}
        placeholder={t('placeholder')}
      />
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground text-xs">
          {count > 0 ? t('count', { count }) : t('off')}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 text-xs"
          disabled={disabled}
          onClick={() =>
            onChange(
              cleanHandoffKeywords([
                ...value.split('\n'),
                ...SUGGESTED_HANDOFF_KEYWORDS,
              ]).join('\n'),
            )
          }
        >
          {t('useSuggestions')}
        </Button>
      </div>
    </div>
  );
}

/** Textarea text → the list to save. */
export function keywordsToList(text: string): string[] {
  return cleanHandoffKeywords(text.split('\n'));
}
