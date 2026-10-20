'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES,
} from '@/lib/storage/upload-media';
import { MEDIA_LIBRARY_MAX, type MediaItem } from '@/lib/ai/media-library';

/**
 * Pictures the agent may send (migration 140, lib/ai/tools/media.ts):
 * each with a name and WHEN to send it — the model decides from the
 * conversation. Uploads go to the same bucket as automation pictures.
 */
export function MediaLibraryField({
  value,
  onChange,
  disabled,
}: {
  value: MediaItem[];
  onChange: (items: MediaItem[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Agents.detail.media');
  const [uploading, setUploading] = useState(false);

  const patch = (i: number, p: Partial<MediaItem>) =>
    onChange(value.map((it, j) => (j === i ? { ...it, ...p } : it)));

  async function add(file: File) {
    if (file.size > MEDIA_MAX_BYTES) {
      toast.error(t('tooLarge'));
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia('flow-media', file);
      const base = file.name.replace(/\.[^.]+$/, '');
      const id =
        base
          .toLowerCase()
          .normalize('NFD')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 30) || `img${value.length + 1}`;
      const unique = value.some((v) => v.id === id)
        ? `${id}-${value.length + 1}`
        : id;
      onChange([
        ...value,
        { id: unique, name: base.slice(0, 80), when: '', url: publicUrl },
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('failed'));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      {value.map((item, i) => (
        <div
          key={item.id}
          className="border-border flex gap-3 rounded-md border p-2"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- account upload */}
          <img
            src={item.url}
            alt=""
            className="size-16 shrink-0 rounded object-cover"
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Input
              value={item.name}
              onChange={(e) => patch(i, { name: e.target.value })}
              placeholder={t('namePlaceholder')}
              aria-label={t('name')}
              disabled={disabled}
              className="h-8 text-sm"
            />
            <Input
              value={item.when}
              onChange={(e) => patch(i, { when: e.target.value })}
              placeholder={t('whenPlaceholder')}
              aria-label={t('when')}
              disabled={disabled}
              className="h-8 text-sm"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label={t('remove')}
            disabled={disabled}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      {value.length < MEDIA_LIBRARY_MAX && (
        <label className="border-border text-muted-foreground hover:bg-muted flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-xs">
          {uploading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ImagePlus className="size-3.5" />
          )}
          {t('add')}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            disabled={disabled || uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void add(f);
              e.target.value = '';
            }}
          />
        </label>
      )}
    </div>
  );
}
