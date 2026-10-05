'use client';

/**
 * Editor top bar — the same chrome as the automation builder: back ·
 * name (with the internal description under it) · Canvas/Lista toggle ·
 * Execuções · delete · Ativo switch · Salvar.
 *
 * Lifted out of flow-builder.tsx so the same toolbar renders above
 * both views in FlowEditorShell. Without this, canvas users had no
 * way to save without toggling to list view.
 *
 * Reads everything from the editor context (`useFlowEditor`) so it
 * stays in sync with whichever view is mutating state, and routes
 * router navigation locally (back to /flows, View runs to
 * /flows/[id]/runs) — those don't belong in the hook.
 */

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, History, Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useFlowEditor } from './flow-editor-state';

export type EditorView = 'canvas' | 'list';

export function EditorHeader({
  view,
  onView,
}: {
  view: EditorView;
  /** Omitted on phones, where only the list view exists. */
  onView?: (v: EditorView) => void;
}) {
  const router = useRouter();
  const t = useTranslations('Flows.header');
  const tB = useTranslations('Flows.builder');
  const tList = useTranslations('Flows.list');
  const {
    flow,
    state,
    setState,
    dirty,
    saving,
    activating,
    canActivate,
    save,
    setStatus,
    deleteFlow,
  } = useFlowEditor();
  const active = state.status === 'active';

  return (
    <header className="border-border bg-card/80 flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:gap-3 sm:px-4">
      <button
        type="button"
        onClick={() => router.push('/flows')}
        aria-label={t('backToFlows')}
        title={t('backToFlows')}
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ease-out"
      >
        <ArrowLeft className="size-4" />
      </button>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <input
            value={state.name}
            onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
            placeholder={t('namePlaceholder')}
            spellCheck={false}
            aria-label={t('namePlaceholder')}
            className="text-foreground placeholder:text-muted-foreground focus:bg-muted min-w-0 flex-1 rounded-md bg-transparent px-2 py-0.5 text-sm font-extrabold tracking-tight outline-none sm:text-base"
          />
          {dirty && (
            <span
              className="bg-tone-salmon-soft text-tone-salmon-ink hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold sm:inline"
              title={t('unsavedHint')}
              aria-live="polite"
            >
              {t('edited')}
            </span>
          )}
        </div>
        <input
          value={state.description}
          onChange={(e) =>
            setState((s) => ({ ...s, description: e.target.value }))
          }
          placeholder={t('descriptionPlaceholder')}
          aria-label={t('descriptionLabel')}
          className="text-muted-foreground placeholder:text-muted-foreground/60 focus:bg-muted focus:text-foreground hidden min-w-0 rounded-md bg-transparent px-2 py-0.5 text-xs outline-none md:block"
        />
      </div>

      {onView && (
        <div
          role="tablist"
          aria-label={tB('editorView')}
          className="bg-muted hidden shrink-0 rounded-full p-1 md:flex"
        >
          {(['canvas', 'list'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={view === k}
              onClick={() => onView(k)}
              className={cn(
                'min-h-8 rounded-full px-3.5 text-[13px] font-semibold transition-colors duration-150 ease-out',
                view === k
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {tB(k === 'canvas' ? 'canvasView' : 'listView')}
            </button>
          ))}
        </div>
      )}

      <Button
        variant="outline"
        onClick={() => router.push(`/flows/${flow.id}/runs`)}
        className="shrink-0"
        title={t('runs')}
      >
        <History className="size-4" />
        <span className="hidden lg:inline">{t('runs')}</span>
        <span className="bg-muted text-muted-foreground rounded-full px-1.5 text-[11px] font-bold tabular-nums">
          {flow.execution_count}
        </span>
      </Button>
      <button
        type="button"
        onClick={() => void deleteFlow()}
        aria-label={t('delete')}
        title={t('delete')}
        className="text-tone-pink-ink hover:bg-tone-pink-soft hidden size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ease-out sm:flex"
      >
        <Trash2 className="size-4" />
      </button>

      <label
        className="text-muted-foreground flex items-center gap-2 text-xs"
        title={!active && !canActivate ? t('fixIssues') : undefined}
      >
        <span className="hidden sm:inline">{tList('statusActive')}</span>
        {activating ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Switch
            checked={active}
            disabled={!active && !canActivate}
            onCheckedChange={(v) => void setStatus(v ? 'active' : 'draft')}
            aria-label={tList('statusActive')}
          />
        )}
      </label>
      <Button
        onClick={() => void save()}
        disabled={saving}
        className="bg-foreground text-background hover:bg-foreground/90 shrink-0"
      >
        {saving && <Loader2 className="size-4 animate-spin" />}
        {t('save')}
      </Button>
    </header>
  );
}
