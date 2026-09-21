'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Bot, RotateCcw, Send, Loader2, UserCircle2, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** assistant-only: the agent signalled a human handoff on this turn. */
  handoff?: boolean;
  /** assistant-only: the reply split into separate WhatsApp-style
   *  bubbles (specs/ai-humanized-multi-message-replies.md) — this is
   *  what the auto-reply bot actually sends, so the Playground renders
   *  these instead of the single joined `content` block. Falls back to
   *  `[content]` when absent/empty so older responses still render. */
  segments?: string[];
}

export function AiPlayground({ onGoToSetup }: { onGoToSetup?: () => void }) {
  const t = useTranslations('Agents.playground');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setInput('');
    setSending(true);
    try {
      const res = await fetch('/api/ai/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send only role+content — the server ignores anything else.
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === 'ai_not_configured') {
          toast.error(t('notConfigured'));
        } else {
          toast.error(data.error ?? t('noReply'));
        }
        // Roll the unsent user turn back so the transcript stays clean.
        setTurns(turns);
        setInput(text);
        return;
      }
      const reply =
        typeof data.reply === 'string' && data.reply.trim() ? data.reply : '';
      const segments = Array.isArray(data.segments)
        ? data.segments.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
        : [];
      // `content` feeds back into the next turn's conversation history
      // (see the `messages` payload below) — join the segments rather
      // than using the raw `reply`, so the model's own multi-message
      // delimiter never shows up in its own history as if it were part
      // of the message text.
      const content = segments.length > 0 ? segments.join('\n\n') : reply;
      setTurns([
        ...next,
        {
          role: 'assistant',
          content,
          segments,
          handoff: Boolean(data.handoff),
        },
      ]);
    } catch {
      toast.error(t('unreachable'));
      setTurns(turns);
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-[60vh] min-h-[420px] flex-col rounded-xl border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">{t('title')}</span>
          <span className="text-xs text-muted-foreground">
            {t('subtitle')}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTurns([])}
          disabled={turns.length === 0 || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> {t('reset')}
        </Button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
            <p>{t('emptyTitle')}</p>
            <p className="mt-1 text-xs">
              {t('emptyDesc')}
            </p>
            {onGoToSetup && (
              <Button
                variant="link"
                size="sm"
                onClick={onGoToSetup}
                className="mt-1 h-auto p-0 text-xs"
              >
                {t('goToSetup')} <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {turns.map((turn, i) => {
          // An assistant reply that was split into several WhatsApp-
          // style bubbles renders as that many separate bubbles, same
          // as the real auto-reply bot would send — a single joined
          // block would misrepresent what the customer actually sees.
          const bubbles =
            turn.role === 'assistant' && turn.segments && turn.segments.length > 0
              ? turn.segments
              : [turn.content];
          return (
            <div
              key={i}
              className={cn(
                'flex gap-2',
                turn.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              {turn.role === 'assistant' && (
                <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />
              )}
              <div
                className={cn(
                  'flex max-w-[80%] flex-col gap-1',
                  turn.role === 'user' ? 'items-end' : 'items-start',
                )}
              >
                {bubbles.map((bubble, j) => (
                  <div
                    key={j}
                    className={cn(
                      'rounded-2xl px-3.5 py-2 text-sm',
                      turn.role === 'user'
                        ? 'rounded-br-sm bg-primary text-primary-foreground'
                        : 'rounded-bl-sm bg-muted text-foreground',
                    )}
                  >
                    {bubble && <p className="whitespace-pre-wrap">{bubble}</p>}
                    {turn.role === 'assistant' &&
                      turn.handoff &&
                      j === bubbles.length - 1 && (
                        <p
                          className={cn(
                            'flex items-center gap-1 text-xs text-amber-500',
                            bubble && 'mt-1.5 border-t border-border/50 pt-1.5',
                          )}
                        >
                          <UserCircle2 className="h-3.5 w-3.5" />
                          {t('handoff')}
                        </p>
                      )}
                  </div>
                ))}
              </div>
              {turn.role === 'user' && (
                <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
              )}
            </div>
          );
        })}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-5 w-5 text-primary" />
            <Loader2 className="h-4 w-4 animate-spin" /> {t('thinking')}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex items-end gap-2 border-t border-border p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('placeholder')}
          rows={1}
          className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <Button
          size="sm"
          onClick={send}
          disabled={!input.trim() || sending}
          className="h-9 w-9 shrink-0 p-0"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
