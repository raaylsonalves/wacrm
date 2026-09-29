'use client';

import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TRANSCRIPTION_MODELS, TRANSCRIBE_MODEL } from '@/lib/ai/transcribe';

const DEFAULT = '__default__';

/**
 * Which model turns this agent's voice notes into text
 * (specs/ai-voice-replies.md, phase 1). Empty = the built-in default.
 * Needs the account's OpenAI key (the knowledge-base key), which is what
 * the hint says.
 */
export function TranscriptionModelField({
  value,
  onChange,
  disabled,
}: {
  /** '' = default. */
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Agents.detail.transcription');
  return (
    <Select
      value={value || DEFAULT}
      onValueChange={(v) => onChange(!v || v === DEFAULT ? '' : v)}
      disabled={disabled}
    >
      <SelectTrigger>
      {/* Base UI resolves a closed Select's label only from mounted
       *  items, so it would show the raw value — resolve it here. */}
        <SelectValue>
          {(v: string) =>
            v === DEFAULT ? t('default', { model: TRANSCRIBE_MODEL }) : v
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>
          {t('default', { model: TRANSCRIBE_MODEL })}
        </SelectItem>
        {TRANSCRIPTION_MODELS.map((m) => (
          <SelectItem key={m} value={m}>
            {m}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
