'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { MessageCircle } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { dateFnsLocale } from '@/lib/date-fns-locale';

/**
 * The contact's conversations — one per WhatsApp number since migration
 * 114 (specs/multi-official-numbers.md). Each links to the inbox, labelled
 * with its number, so a contact who talks to reception and to sales shows
 * both threads. Hidden when the contact has none.
 */

interface Row {
  id: string;
  status: string;
  last_message_at: string | null;
  whatsapp_channel_id: string | null;
  whatsapp_config_id: string | null;
}

export function ContactConversations({ contactId }: { contactId: string }) {
  const t = useTranslations('Contacts.detailView.conversations');
  const [rows, setRows] = useState<Row[]>([]);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [primaryId, setPrimaryId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const db = createClient();
    void (async () => {
      const [{ data: convs }, { data: channels }, numbersRes] =
        await Promise.all([
          db
            .from('conversations')
            .select(
              'id, status, last_message_at, whatsapp_channel_id, whatsapp_config_id'
            )
            .eq('contact_id', contactId)
            .order('last_message_at', { ascending: false, nullsFirst: false }),
          db.from('whatsapp_waha_channels').select('id, label'),
          fetch('/api/whatsapp/numbers', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);
      if (!alive) return;
      const map = new Map<string, string>();
      for (const c of (channels ?? []) as { id: string; label: string }[])
        map.set(c.id, c.label);
      const numbers = (numbersRes?.numbers ?? []) as {
        id: string;
        label: string | null;
        display_phone_number: string | null;
        phone_number_id: string;
        is_primary: boolean;
      }[];
      for (const n of numbers)
        map.set(n.id, n.label || n.display_phone_number || n.phone_number_id);
      setPrimaryId(numbers.find((n) => n.is_primary)?.id ?? null);
      setLabels(map);
      setRows((convs ?? []) as Row[]);
    })();
    return () => {
      alive = false;
    };
  }, [contactId]);

  if (rows.length === 0) return null;

  const numberLabel = (r: Row) =>
    (r.whatsapp_channel_id && labels.get(r.whatsapp_channel_id)) ||
    labels.get(r.whatsapp_config_id ?? primaryId ?? '') ||
    t('officialApi');

  return (
    <div className="px-5 pb-3">
      <p className="text-muted-foreground mb-1.5 text-[11px] font-semibold tracking-wide uppercase">
        {t('title')}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/inbox?c=${r.id}`}
              className="border-border hover:bg-muted inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
            >
              <MessageCircle className="size-3.5 shrink-0" />
              <span className="text-foreground font-medium">
                {numberLabel(r)}
              </span>
              <span className="text-muted-foreground">
                {r.status === 'closed'
                  ? t('closed')
                  : r.last_message_at
                    ? formatDistanceToNow(new Date(r.last_message_at), {
                        addSuffix: true,
                        locale: dateFnsLocale,
                      })
                    : t('open')}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
