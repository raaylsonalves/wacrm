'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  type ExistingContact,
} from '@/lib/contacts/dedupe';
import { useIsDesktop } from '@/components/ui/side-panel';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const fieldCls =
  'border-border bg-card text-foreground focus:border-foreground rounded-2xl border-[1.5px] px-3.5 py-3 text-base font-bold transition-colors duration-150 ease-out outline-none';

/**
 * v8 quick create: phone and name — what a contact needs to exist. Email,
 * company, tags and custom fields are filled in on the contact view
 * ("Criar e abrir ficha" jumps straight there). A small dialog on desktop,
 * a bottom sheet on phones.
 */
export function ContactQuickCreate({
  open,
  onOpenChange,
  onCreated,
  onViewExisting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new contact's id; `openPanel` when the user asked to open it. */
  onCreated: (contactId: string, openPanel: boolean) => void;
  /** Open the contact that already owns this number. */
  onViewExisting: (contactId: string) => void;
}) {
  const isDesktop = useIsDesktop();
  const t = useTranslations('Contacts.form');
  const body = open ? (
    <QuickCreateForm
      onViewExisting={(id) => {
        onOpenChange(false);
        onViewExisting(id);
      }}
      onDone={(id, openPanel) => {
        onOpenChange(false);
        onCreated(id, openPanel);
      }}
    />
  ) : null;

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 p-0 sm:max-w-[440px]">
          <DialogTitle className="px-6 pt-5 pb-1 text-xl font-extrabold tracking-[-0.01em]">
            {t('quickTitle')}
          </DialogTitle>
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="max-h-[92dvh] gap-0 overflow-y-auto p-0"
      >
        <div className="flex justify-center pt-2.5 pb-1" aria-hidden>
          <span className="bg-border h-1.5 w-11 rounded-full" />
        </div>
        <SheetTitle className="px-5 pt-1 pb-1 text-xl font-extrabold">
          {t('quickTitle')}
        </SheetTitle>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function QuickCreateForm({
  onDone,
  onViewExisting,
}: {
  onDone: (contactId: string, openPanel: boolean) => void;
  onViewExisting: (contactId: string) => void;
}) {
  const t = useTranslations('Contacts.form');
  const { accountId } = useAuth();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<false | 'plain' | 'open'>(false);
  // An exact match (same digits) blocks the save; a trunk-variant match
  // only warns. The DB unique index (migration 022) is the real backstop.
  const [dupMatch, setDupMatch] = useState<{
    contact: ExistingContact;
    exact: boolean;
  } | null>(null);

  async function checkDuplicate() {
    const value = phone.trim();
    if (!value || !accountId) {
      setDupMatch(null);
      return;
    }
    const existing = await findExistingContact(
      createClient(),
      accountId,
      value
    );
    setDupMatch(
      existing
        ? { contact: existing, exact: isExactMatch(existing, value) }
        : null
    );
  }

  async function create(openPanel: boolean) {
    if (busy) return;
    if (!phone.trim()) {
      toast.error(t('phoneRequired'));
      return;
    }
    if (dupMatch?.exact) {
      toast.error(t('toastConflict'));
      return;
    }
    setBusy(openPanel ? 'open' : 'plain');
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.user || !accountId) {
      toast.error(t('toastError'));
      setBusy(false);
      return;
    }
    const { data, error } = await supabase
      .from('contacts')
      .insert({
        user_id: session.user.id,
        account_id: accountId,
        name: name.trim() || null,
        phone: phone.trim(),
      })
      .select('id')
      .single();
    if (error || !data) {
      if (isUniqueViolation(error)) {
        toast.error(t('toastConflict'));
        const existing = await findExistingContact(
          supabase,
          accountId,
          phone.trim()
        );
        if (existing) setDupMatch({ contact: existing, exact: true });
      } else {
        toast.error(t('toastError'));
      }
      setBusy(false);
      return;
    }
    if (!openPanel) {
      toast.success(t('toastSuccessAdd'), {
        action: { label: t('openPanel'), onClick: () => onDone(data.id, true) },
      });
    }
    onDone(data.id, openPanel);
  }

  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void create(false);
      }}
    >
      <div className="flex flex-col gap-4 px-5 pt-3 pb-2 lg:px-6">
        <label className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[12.5px] font-bold">
            {t('phoneLabel')}
          </span>
          <input
            autoFocus
            inputMode="tel"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              if (dupMatch) setDupMatch(null);
            }}
            onBlur={checkDuplicate}
            placeholder={t('phonePlaceholder')}
            className={cn(fieldCls, 'tabular-nums')}
          />
          {dupMatch ? (
            <span
              className={cn(
                'flex items-start gap-2 rounded-xl px-3 py-2 text-xs',
                dupMatch.exact
                  ? 'bg-tone-pink-soft text-tone-pink-ink'
                  : 'bg-tone-salmon/20 text-foreground'
              )}
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="flex flex-col items-start gap-1">
                {dupMatch.exact ? t('dupExact') : t('dupSimilar')}
                <button
                  type="button"
                  onClick={() => onViewExisting(dupMatch.contact.id)}
                  className="font-bold underline underline-offset-2 hover:no-underline"
                >
                  {t('viewExisting', {
                    name: dupMatch.contact.name || dupMatch.contact.phone,
                  })}
                </button>
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              {t('phoneHint')}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[12.5px] font-bold">
            {t('nameLabel')}
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            className={fieldCls}
          />
        </label>
        <p className="text-muted-foreground text-[12.5px]">{t('quickHint')}</p>
      </div>
      <div className="flex flex-col-reverse gap-2 px-5 pt-3 pb-5 sm:flex-row sm:justify-end lg:px-6">
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4 sm:h-10"
          disabled={!!busy}
          onClick={() => void create(true)}
        >
          {busy === 'open' && <Loader2 className="size-4 animate-spin" />}
          {t('createAndOpen')}
        </Button>
        <Button
          type="submit"
          className="h-12 px-5 text-[15px] sm:h-10 sm:text-sm"
          disabled={!!busy}
        >
          {busy === 'plain' && <Loader2 className="size-4 animate-spin" />}
          {t('save')}
        </Button>
      </div>
    </form>
  );
}
