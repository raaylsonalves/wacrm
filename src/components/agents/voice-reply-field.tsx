'use client';

import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DEFAULT_VOICE, VOICES } from '@/lib/ai/voice-reply';

/**
 * Answer voice notes with a voice note (specs/ai-voice-replies.md, phase 2):
 * the mode, and which voice speaks. Off by default.
 */
export function VoiceReplyField({
  mode,
  voice,
  onModeChange,
  onVoiceChange,
  disabled,
}: {
  mode: 'off' | 'mirror';
  /** '' = default voice. */
  voice: string;
  onModeChange: (m: 'off' | 'mirror') => void;
  onVoiceChange: (v: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Agents.detail.voice');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Select
        value={mode}
        onValueChange={(v) => onModeChange(v === 'mirror' ? 'mirror' : 'off')}
        disabled={disabled}
      >
        <SelectTrigger>
        {/* Base UI resolves a closed Select's label only from mounted
         *  items, so it would show the raw value — resolve it here. */}
          <SelectValue>
            {(v: string) => (v === 'mirror' ? t('mirror') : t('off'))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">{t('off')}</SelectItem>
          <SelectItem value="mirror">{t('mirror')}</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={voice || DEFAULT_VOICE}
        onValueChange={(v) => onVoiceChange(v === DEFAULT_VOICE ? '' : (v ?? ''))}
        disabled={disabled || mode === 'off'}
      >
        <SelectTrigger>
          <SelectValue>{(v: string) => t('voiceOption', { voice: v })}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {VOICES.map((v) => (
            <SelectItem key={v} value={v}>
              {t('voiceOption', { voice: v })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
