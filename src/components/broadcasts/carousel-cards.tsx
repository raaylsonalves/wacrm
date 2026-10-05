'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { GalleryHorizontal, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { uploadAccountMedia } from '@/lib/storage/upload-media';
import type { CarouselCard } from '@/lib/whatsapp/template-carousel';

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Every card has a usable media link — the Next button's gate. */
export function carouselMediaReady(
  cards: CarouselCard[],
  media: string[]
): boolean {
  return cards.every((c) => isHttpUrl((media[c.index] ?? '').trim()));
}

/**
 * The media of each carousel card (migration 100). Meta needs it on every
 * send; it starts from what the template has saved (or Meta's approval
 * sample) and is saved back on the template when the broadcast goes out,
 * so the next send, scheduled runs and automations reuse it.
 */
export function CarouselCardsEditor({
  cards,
  media,
  onChange,
}: {
  cards: CarouselCard[];
  media: string[];
  onChange: (media: string[]) => void;
}) {
  const t = useTranslations('Broadcasts.wizard.personalize.carousel');
  const [uploading, setUploading] = useState<number | null>(null);
  const fileRefs = useRef<(HTMLInputElement | null)[]>([]);

  const set = (i: number, value: string) => {
    const next = [...media];
    next[i] = value;
    onChange(next);
  };

  async function upload(i: number, file: File) {
    setUploading(i);
    try {
      const { publicUrl } = await uploadAccountMedia('chat-media', file);
      set(i, publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('uploadFailed'));
    } finally {
      setUploading(null);
    }
  }

  return (
    <div className="border-border bg-card/50 rounded-xl border p-4">
      <div className="mb-1 flex items-center gap-2">
        <GalleryHorizontal className="text-primary h-4 w-4" />
        <p className="text-foreground text-sm font-medium">
          {t('title', { count: cards.length })}
        </p>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">{t('hint')}</p>
      <div className="space-y-3">
        {cards.map((card) => {
          const value = media[card.index] ?? '';
          const bad = value.trim() !== '' && !isHttpUrl(value.trim());
          return (
            <div
              key={card.index}
              className="border-border flex gap-3 rounded-lg border p-2"
            >
              <div className="bg-muted flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md">
                {card.mediaType === 'image' && isHttpUrl(value.trim()) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={value.trim()}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-muted-foreground text-[10px] uppercase">
                    {card.mediaType}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-foreground truncate text-xs font-medium">
                  {t('card', { n: card.index + 1 })}
                  {card.bodyText && (
                    <span className="text-muted-foreground font-normal">
                      {' '}
                      · {card.bodyText}
                    </span>
                  )}
                </p>
                <div className="flex gap-2">
                  <Input
                    type="url"
                    value={value}
                    onChange={(e) => set(card.index, e.target.value)}
                    placeholder={t('urlPlaceholder')}
                    className="h-8 text-xs"
                  />
                  <input
                    ref={(el) => {
                      fileRefs.current[card.index] = el;
                    }}
                    type="file"
                    accept={
                      card.mediaType === 'video'
                        ? 'video/mp4,video/3gpp'
                        : 'image/jpeg,image/png'
                    }
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(card.index, f);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={uploading !== null}
                    onClick={() => fileRefs.current[card.index]?.click()}
                    aria-label={t('upload')}
                  >
                    {uploading === card.index ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                {(bad || !value.trim()) && (
                  <p className="text-[11px] text-tone-salmon-ink">
                    {bad ? t('invalid') : t('missing')}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** WhatsApp-like preview: the message bubble, then the cards side by side. */
export function CarouselPreview({
  text,
  cards,
  media,
}: {
  text: string;
  cards: CarouselCard[];
  media: string[];
}) {
  return (
    <div className="space-y-2">
      {text && (
        <div className="bg-primary ml-auto max-w-[85%] rounded-lg px-3 py-2 shadow-sm">
          <p className="text-primary-foreground text-sm whitespace-pre-wrap">
            {text}
          </p>
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {cards.map((card) => {
          const src = (media[card.index] ?? '').trim();
          return (
            <div
              key={card.index}
              className="bg-card w-44 shrink-0 overflow-hidden rounded-lg border shadow-sm"
            >
              <div className="bg-muted flex h-28 items-center justify-center">
                {card.mediaType === 'image' && src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-muted-foreground text-xs uppercase">
                    {card.mediaType}
                  </span>
                )}
              </div>
              {card.bodyText && (
                <p className="text-foreground px-2 pt-2 text-xs">
                  {card.bodyText}
                </p>
              )}
              <div className="divide-border mt-2 divide-y border-t">
                {card.buttons.map((b, i) => (
                  <p
                    key={i}
                    className="text-foreground py-1.5 text-center text-xs font-medium"
                  >
                    {b.text}
                  </p>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
