'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Lock, Plus, Trash2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTeamProfiles } from '@/hooks/queries/use-inbox-lookups';
import { useCan } from '@/hooks/use-can';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { Button } from '@/components/ui/button';
import type { ConversationNote } from '@/types';
import { confirmDialog } from '@/components/confirm-dialog';

/**
 * Teammate-only notes on one conversation (migration 070). Lives in its
 * own table, never in `messages`, so nothing that renders the customer
 * thread can ever pick one up. Amber card style marks them as internal.
 */
export function ConversationNotes({
  conversationId,
}: {
  conversationId: string;
}) {
  const t = useTranslations('Inbox.conversationNotes');
  const { user, accountId } = useAuth();
  const canWrite = useCan('send-messages');

  const [notes, setNotes] = useState<ConversationNote[]>([]);
  const { data: profiles } = useTeamProfiles();
  const authors = useMemo(
    () => new Map((profiles ?? []).map((p) => [p.user_id, p.full_name ?? ''])),
    [profiles]
  );
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // The parent keys this component by conversation id, so switching
  // threads remounts it with fresh state — no manual reset needed.
  useEffect(() => {
    let cancelled = false;
    createClient()
      .from('conversation_notes')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Failed to load conversation notes:', error);
          return;
        }
        setNotes((data as ConversationNote[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  async function handleAdd() {
    const body = draft.trim();
    if (!body || !user || !accountId) return;
    setSaving(true);
    const { data, error } = await createClient()
      .from('conversation_notes')
      .insert({
        conversation_id: conversationId,
        account_id: accountId,
        author_user_id: user.id,
        body,
      })
      .select('*')
      .single();
    setSaving(false);
    if (error || !data) {
      console.error('Failed to add conversation note:', error);
      toast.error(t('addFailed'));
      return;
    }
    setNotes((prev) => [data as ConversationNote, ...prev]);
    setDraft('');
  }

  async function handleDelete(id: string) {
    await confirmDialog(t('deleteConfirm'), {
      action: async () => {
        const { error } = await createClient()
          .from('conversation_notes')
          .delete()
          .eq('id', id);
        if (error) {
          toast.error(t('deleteFailed'));
          return;
        }
        setNotes((prev) => prev.filter((n) => n.id !== id));
      },
    });
  }

  return (
    <div>
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
        <Lock className="h-3 w-3" />
        {t('title')}
      </div>
      <p className="text-muted-foreground mt-1 px-1 text-[10px]">{t('hint')}</p>
      {canWrite && (
        <div className="mt-2 flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('placeholder')}
            maxLength={5000}
            rows={2}
            className="text-foreground placeholder-muted-foreground flex-1 resize-none rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs outline-none focus:border-amber-500/60"
          />
          <Button
            size="sm"
            className="h-auto px-2"
            onClick={handleAdd}
            disabled={!draft.trim() || saving}
            aria-label={t('add')}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      )}
      <div className="mt-2 space-y-2">
        {notes.map((note) => (
          <div
            key={note.id}
            className="group rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2"
          >
            <p className="text-foreground text-xs whitespace-pre-wrap">
              {note.body}
            </p>
            <div className="text-muted-foreground mt-1 flex items-center justify-between gap-2 text-[10px]">
              <span className="truncate">
                {(note.author_user_id && authors.get(note.author_user_id)) ||
                  t('unknownAuthor')}{' '}
                ·{' '}
                {format(new Date(note.created_at), 'MMM d, HH:mm', {
                  locale: dateFnsLocale,
                })}
              </span>
              {note.author_user_id === user?.id && (
                <button
                  type="button"
                  onClick={() => handleDelete(note.id)}
                  className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-600 focus:opacity-100"
                  aria-label={t('delete')}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
