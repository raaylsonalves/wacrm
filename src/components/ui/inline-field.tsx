'use client';

import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * v8 edit pattern: a value that reads like text and becomes an input on
 * click. Enter (or leaving the field) saves, Esc cancels; nothing is sent
 * when the value didn't change. Saving itself is the caller's job — the
 * surrounding view shows "Salvando…" / "✓ Salvo".
 */
export function InlineField({
  label,
  value,
  onSave,
  display,
  placeholder,
  type = 'text',
  multiline = false,
  inputMode,
  disabled = false,
  className,
  inputClassName,
  layout = 'row',
}: {
  /** Shown left of the value (row) or above it (stack); also the input's label. */
  label: string;
  value: string;
  onSave: (next: string) => void;
  /** What the value looks like at rest; defaults to the raw value. */
  display?: React.ReactNode;
  placeholder?: string;
  type?: 'text' | 'number' | 'date' | 'time';
  multiline?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  /** "row": label | value (details list). "bare": no label (titles). */
  layout?: 'row' | 'bare';
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const start = () => {
    if (disabled) return;
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (draft.trim() !== value.trim()) onSave(draft.trim());
  };
  const cancel = () => setEditing(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Esc here cancels the field, not the whole panel.
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  };

  const inputCls = cn(
    'border-foreground bg-card text-foreground w-full min-w-0 rounded-xl border-[1.5px] px-3 py-2 text-sm outline-none',
    inputClassName
  );

  if (editing) {
    const field = multiline ? (
      <textarea
        autoFocus
        aria-label={label}
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={cn(inputCls, 'resize-none leading-relaxed')}
      />
    ) : (
      <input
        autoFocus
        aria-label={label}
        type={type}
        inputMode={inputMode}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={inputCls}
      />
    );
    return layout === 'row' ? (
      <div className={cn('flex min-h-11 items-center gap-3', className)}>
        <span className="text-muted-foreground w-36 shrink-0 text-[12.5px]">
          {label}
        </span>
        {field}
      </div>
    ) : (
      <div className={className}>{field}</div>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled}
      aria-label={`${label}: ${value || placeholder || ''}`}
      className={cn(
        'group/field -mx-2.5 flex min-h-11 w-[calc(100%+1.25rem)] items-center gap-3 rounded-[14px] px-2.5 text-left transition-colors duration-150 ease-out',
        !disabled && 'hover:bg-muted',
        className
      )}
    >
      {layout === 'row' && (
        <span className="text-muted-foreground w-36 shrink-0 text-[12.5px]">
          {label}
        </span>
      )}
      <span
        className={cn(
          'min-w-0 flex-1 text-sm font-semibold',
          !multiline && 'truncate',
          layout === 'row' && 'text-right',
          multiline && 'whitespace-pre-line',
          !value && 'text-muted-foreground font-normal'
        )}
      >
        {display ?? (value || placeholder)}
      </span>
      {!disabled && (
        <Pencil className="text-muted-foreground size-3.5 shrink-0 opacity-0 transition-opacity duration-150 group-hover/field:opacity-100 group-focus-visible/field:opacity-100" />
      )}
    </button>
  );
}
