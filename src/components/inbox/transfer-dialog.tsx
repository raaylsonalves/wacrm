'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Hand a conversation to a teammate with an optional note. The note is
 * saved as an internal conversation note FIRST, then the assignment is
 * written — the assignment trigger (migration 088) picks up a note the
 * same person wrote on this conversation in the last minute and puts it
 * in the assignee's notification, so they know why without opening it.
 */
export function TransferDialog({
  conversationId,
  target,
  onClose,
  onAssign,
}: {
  conversationId: string;
  target: { user_id: string; full_name: string } | null;
  onClose: () => void;
  /** Writes the assignment (the thread's existing handler). */
  onAssign: (userId: string) => Promise<void>;
}) {
  const t = useTranslations('Inbox.transfer');
  const { accountId, user } = useAuth();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!target) return;
    setBusy(true);
    try {
      const body = note.trim();
      if (body && accountId && user) {
        const { error } = await createClient()
          .from('conversation_notes')
          .insert({
            conversation_id: conversationId,
            account_id: accountId,
            author_user_id: user.id,
            body: t('noteBody', { name: target.full_name, note: body }),
          });
        if (error) {
          toast.error(t('noteFailed'));
          return;
        }
      }
      await onAssign(target.user_id);
      toast.success(t('done', { name: target.full_name }));
      setNote('');
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={!!target}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('title', { name: target?.full_name ?? '' })}
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          maxLength={1000}
          placeholder={t('placeholder')}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRightLeft className="h-4 w-4" />
            )}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
