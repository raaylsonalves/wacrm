'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AiProvider } from '@/lib/ai/types';
import type { ModelOption } from '@/lib/ai/models';

type State =
  | { status: 'loading' }
  | { status: 'ok'; models: ModelOption[] }
  | { status: 'error'; code: string };

function formatWindow(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
}

function formatPrice(n: number): string {
  return n >= 10 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Model picker fed by the provider (specs/ai-agents-management.md §1):
 * lists what the key can actually use, with the context window and price
 * only when the provider supplied them — never guessed.
 *
 * The input is always a free-text id, so a provider hiccup, an invalid
 * key or a model the list missed can NEVER block a save; the list is a
 * convenience layered over it.
 */
export function ModelPicker({
  provider,
  apiKey,
  agentId,
  value,
  onChange,
  disabled,
}: {
  provider: AiProvider;
  /** Candidate key being typed; blank uses the agent's stored key. */
  apiKey: string;
  agentId?: string;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Agents.detail.picker');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [open, setOpen] = useState(false);
  // Only filter while the user is typing: opening the list on a stored
  // model should show the whole catalogue, not just that one row.
  const [query, setQuery] = useState('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setState({ status: 'loading' });
    try {
      const res = await fetch('/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          api_key: apiKey || undefined,
          agent_id: agentId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (mine !== seq.current) return; // a newer request superseded this one
      if (data?.ok) setState({ status: 'ok', models: data.models ?? [] });
      else setState({ status: 'error', code: data?.code ?? 'unreachable' });
    } catch {
      if (mine === seq.current) setState({ status: 'error', code: 'unreachable' });
    }
    // The key is deliberately NOT a dependency: it changes on every
    // keystroke, and the list is refreshed by the button / a provider
    // change instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const models = useMemo(
    () => (state.status === 'ok' ? state.models : []),
    [state],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
    );
  }, [models, query]);

  const known = models.find((m) => m.id === value);

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Input
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setQuery('');
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          placeholder={t('placeholder')}
          autoComplete="off"
          spellCheck={false}
        />
        {open && state.status === 'ok' && filtered.length > 0 && (
          <ul className="border-border bg-popover absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border shadow-lg">
            {filtered.slice(0, 100).map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  // mousedown, not click: click fires after the input's
                  // blur has already closed the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(m.id);
                    setQuery('');
                    setOpen(false);
                  }}
                  className={cn(
                    'hover:bg-muted flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm',
                    m.id === value && 'bg-muted/60',
                  )}
                >
                  <span className="text-foreground font-medium">{m.label}</span>
                  <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-[11px]">
                    <span className="font-mono">{m.id}</span>
                    {m.contextWindow !== undefined && (
                      <span>{t('window', { size: formatWindow(m.contextWindow) })}</span>
                    )}
                    {m.inputPerMTok !== undefined && m.outputPerMTok !== undefined && (
                      <span>
                        {t('price', {
                          input: formatPrice(m.inputPerMTok),
                          output: formatPrice(m.outputPerMTok),
                        })}
                      </span>
                    )}
                    {m.supportsTools === false && (
                      <span className="rounded-full bg-amber-500/15 px-1.5 text-amber-700 dark:text-amber-300">
                        {t('noTools')}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        {state.status === 'loading' && (
          <>
            <Loader2 className="size-3 animate-spin" />
            {t('loading')}
          </>
        )}
        {state.status === 'ok' && (
          <span>
            {models.length > 0
              ? t('available', { count: models.length })
              : t('empty')}
            {value && models.length > 0 && !known && ` · ${t('customId')}`}
          </span>
        )}
        {state.status === 'error' && (
          <span>{t(`error.${state.code}`)} {t('typeTheId')}</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 text-xs"
          onClick={() => void load()}
          disabled={disabled || state.status === 'loading'}
        >
          <RefreshCw className="size-3" />
          {t('refresh')}
        </Button>
      </div>

      {known?.supportsTools === false && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200">
          {t('noToolsWarning')}
        </p>
      )}
    </div>
  );
}
