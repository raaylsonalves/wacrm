'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import {
  useContactsLite,
  type ContactLite,
} from '@/hooks/queries/use-crm-lookups';
import { TONE_SOLID, toneFor } from '@/lib/tones';
import { cn } from '@/lib/utils';

const MAX_RESULTS = 6;

function initials(c: ContactLite) {
  const name = (c.name || c.phone || '?').trim();
  const parts = name.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/**
 * Pick a contact by typing part of the name or phone. Shows the chosen
 * contact as a chip with "Trocar"; the list stays short (best 6 matches)
 * so it fits a quick-create dialog or a phone sheet.
 */
export function ContactPicker({
  value,
  onChange,
  autoFocus,
}: {
  value: ContactLite | null;
  onChange: (c: ContactLite | null) => void;
  autoFocus?: boolean;
}) {
  const t = useTranslations('Pipelines.panel');
  const { data: contacts = [], isPending } = useContactsLite();
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const list = q
      ? contacts.filter(
          (c) =>
            (c.name ?? '').toLowerCase().includes(q) ||
            (digits.length >= 3 && c.phone.replace(/\D/g, '').includes(digits))
        )
      : contacts;
    return list.slice(0, MAX_RESULTS);
  }, [contacts, query]);

  if (value) {
    const name = value.name || value.phone;
    return (
      <div className="border-border flex items-center gap-2.5 rounded-2xl border-[1.5px] px-2.5 py-2">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
            TONE_SOLID[toneFor(name)]
          )}
        >
          {initials(value)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-sm">{name}</strong>
          {value.name && (
            <span className="text-muted-foreground truncate text-xs">
              {value.phone}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-muted-foreground hover:text-foreground rounded-full px-2 py-1 text-[12.5px] font-semibold"
        >
          {t('change')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="relative block">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchContact')}
          aria-label={t('searchContact')}
          className="border-border bg-card text-foreground focus:border-foreground w-full rounded-2xl border-[1.5px] py-2.5 pr-3 pl-9 text-sm transition-colors duration-150 ease-out outline-none"
        />
      </label>
      <div
        role="listbox"
        aria-label={t('client')}
        className="border-border flex max-h-56 flex-col overflow-y-auto rounded-2xl border p-1"
      >
        {isPending ? (
          <span className="text-muted-foreground px-3 py-2 text-sm">…</span>
        ) : results.length === 0 ? (
          <span className="text-muted-foreground px-3 py-2 text-sm">
            {t('noResults')}
          </span>
        ) : (
          results.map((c) => {
            const name = c.name || c.phone;
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => onChange(c)}
                className="hover:bg-muted flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 ease-out"
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold',
                    TONE_SOLID[toneFor(name)]
                  )}
                >
                  {initials(c)}
                </span>
                <span className="flex min-w-0 flex-col">
                  <strong className="truncate text-[13.5px]">{name}</strong>
                  {c.name && (
                    <span className="text-muted-foreground truncate text-xs">
                      {c.phone}
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
