'use client';

import { ContactConversations } from './contact-conversations';
import { TONE_SOLID, toneFor } from '@/lib/tones';
import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { formatCurrency, APP_LOCALE } from '@/lib/currency';
import { toast } from 'sonner';
import type {
  Contact,
  Tag,
  ContactNote,
  CustomField,
  Deal,
  MessageTemplate,
} from '@/types';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import { SaveState, SidePanel } from '@/components/ui/side-panel';
import { InlineField } from '@/components/ui/inline-field';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  ScrollEdgeFades,
  useHorizontalScrollEdges,
} from '@/components/ui/scroll-edges';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Phone,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  X,
  DollarSign,
  LayoutTemplate,
  ShieldOff,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { contactHandle } from '@/lib/whatsapp/wa-identity';
import { confirmDialog } from '@/components/confirm-dialog';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
  const t = useTranslations('Contacts.detailView');
  const tForm = useTranslations('Contacts.form');
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();
  const canManageLgpd = useCan('manage-lgpd');

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  // Tab bar scrolls horizontally (YouTube-style pill chips) instead of
  // clipping — the panel is narrow enough that all 5 tabs never fit.
  const {
    ref: tabsScrollRef,
    canLeft: tabsCanLeft,
    canRight: tabsCanRight,
    scrollByDir: tabsScrollByDir,
    recompute: recomputeTabsScroll,
  } = useHorizontalScrollEdges<HTMLDivElement>();

  // The sheet (and this scroll row inside it) isn't in the layout flow
  // while closed, so the mount-time measurement in the hook can run
  // against a zero-size box. Re-measure once the sheet has actually
  // opened and settled into place.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(recomputeTabsScroll, 250);
    return () => clearTimeout(id);
  }, [open, recomputeTabsScroll]);

  // Send template — lets the business initiate (or re-open) a conversation
  // with this contact by sending an approved template. The send route
  // find-or-creates the conversation, so no inbound message is required.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  // Details tab
  // v8: every field saves on its own; the header reads the combined state.
  const [pendingSaves, setPendingSaves] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [anonymizing, setAnonymizing] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  const fetchContact = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    // Clear the previous contact's data up front. `.single()` errors on
    // 0 rows (deleted elsewhere, or RLS), and only assigning inside
    // `if (data)` used to leave the last contact's name/phone/email in
    // the form — switching from contact A to a contact B whose fetch
    // fails left A's details on screen keyed to B's id, so pressing
    // Save would overwrite B with A's data.
    setContact(null);

    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (error || !data) {
      toast.error(t('toastLoadFailed'));
    } else {
      setContact(data);
    }
    setLoading(false);
  }, [contactId, supabase, t]);

  const fetchTags = useCallback(async () => {
    if (!contactId) return;

    const [tagsRes, contactTagsRes] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase
        .from('contact_tags')
        .select('tag_id')
        .eq('contact_id', contactId),
    ]);

    if (tagsRes.data) setAllTags(tagsRes.data);
    if (contactTagsRes.data) {
      setContactTagIds(contactTagsRes.data.map((ct) => ct.tag_id));
    }
  }, [contactId, supabase]);

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    const { data } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [contactId, supabase]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      supabase.from('custom_fields').select('*').order('field_name'),
      supabase
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      valuesRes.data.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    }
    setLoadingCustom(false);
  }, [contactId, supabase]);

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    const { data } = await supabase
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [contactId, supabase]);

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchTags();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
    }
  }, [
    open,
    contactId,
    fetchContact,
    fetchTags,
    fetchNotes,
    fetchCustomFields,
    fetchDeals,
  ]);

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contactHandle(contact));
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  /** Run one write, keeping the header's "Salvando… / ✓ Salvo" honest. */
  async function track(write: () => PromiseLike<{ error: unknown }>) {
    setPendingSaves((n) => n + 1);
    setSaveFailed(false);
    const { error } = await write();
    setPendingSaves((n) => n - 1);
    if (error) setSaveFailed(true);
    else setSavedAt(Date.now());
    return error;
  }

  async function saveField(
    key: 'name' | 'phone' | 'email' | 'company',
    value: string
  ) {
    if (!contactId || !contact) return;
    if (key === 'phone' && !value) {
      toast.error(t('toastPhoneRequired'));
      return;
    }
    const prev = contact;
    const next = key === 'phone' ? value : value || null;
    setContact({ ...contact, [key]: next });
    const error = await track(() =>
      supabase
        .from('contacts')
        .update({ [key]: next, updated_at: new Date().toISOString() })
        .eq('id', contactId)
    );
    if (error) {
      setContact(prev);
      toast.error(
        isUniqueViolation(error)
          ? tForm('toastConflict')
          : t('toastUpdateFailed')
      );
    } else {
      onUpdated();
    }
  }

  async function anonymizeContact() {
    if (!contactId) return;
    await confirmDialog(t('lgpd.anonymizeConfirm'), {
      action: async () => {
        setAnonymizing(true);
        try {
          const res = await fetch(`/api/contacts/${contactId}/anonymize`, {
            method: 'POST',
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            toast.error(payload?.error || t('lgpd.toastAnonymizeFailed'));
            return;
          }
          toast.success(t('lgpd.toastAnonymized'));
          fetchContact();
          onUpdated();
        } catch {
          toast.error(t('lgpd.toastAnonymizeFailed'));
        } finally {
          setAnonymizing(false);
        }
      },
    });
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);

    const isSelected = contactTagIds.includes(tagId);

    try {
      if (isSelected) {
        await deleteContactTag(contactId, tagId);
        setContactTagIds((prev) => prev.filter((id) => id !== tagId));
      } else {
        await addContactTag(contactId, tagId);
        setContactTagIds((prev) => [...prev, tagId]);
      }
      onUpdated();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('toastUpdateFailed')
      );
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user || !accountId) {
      toast.error(t('toastNotAuthenticated'));
      setSavingNote(false);
      return;
    }

    const { error } = await supabase.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: user.id,
      note_text: newNote.trim(),
    });

    if (error) {
      toast.error(t('toastNoteAddFailed'));
    } else {
      setNewNote('');
      fetchNotes();
      toast.success(t('toastNoteAdded'));
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      toast.error(t('toastNoteDeleteFailed'));
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success(t('toastNoteDeleted'));
    }
  }

  // Upsert a filled value, delete a cleared one — one field at a time, so a
  // failure can only ever touch the field being edited.
  async function saveCustomField(fieldId: string, value: string) {
    if (!contactId) return;
    const prev = customValues[fieldId] ?? '';
    setCustomValues((m) => ({ ...m, [fieldId]: value }));
    const error = await track(() =>
      value
        ? supabase
            .from('contact_custom_values')
            .upsert(
              { contact_id: contactId, custom_field_id: fieldId, value },
              { onConflict: 'contact_id,custom_field_id' }
            )
        : supabase
            .from('contact_custom_values')
            .delete()
            .eq('contact_id', contactId)
            .eq('custom_field_id', fieldId)
    );
    if (error) {
      setCustomValues((m) => ({ ...m, [fieldId]: prev }));
      toast.error(t('toastCustomFieldsFailed'));
    }
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues
  ) {
    if (!contactId) return;
    setSendingTemplate(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No conversation_id — the route find-or-creates one for this
          // contact, mirroring the inbox template-send payload otherwise.
          contact_id: contactId,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = payload?.error || `HTTP ${res.status}`;
        toast.error(t('toastTemplateFailed', { reason }));
        return;
      }

      toast.success(t('toastTemplateSent', { name: template.name }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'network error';
      toast.error(`Failed to send template: ${reason}`);
    } finally {
      setSendingTemplate(false);
    }
  }

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  return (
    <>
      <SidePanel
        open={open && !!contactId}
        onClose={() => onOpenChange(false)}
        label={t('contactInfo')}
      >
        {loading || !contact ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="text-muted-foreground size-6 animate-spin" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 px-5 pt-4">
              <span className="flex-1" />
              <SaveState
                pending={pendingSaves > 0}
                failed={saveFailed}
                savedAt={savedAt}
              />
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label={t('close')}
                className="hover:bg-muted flex size-9 items-center justify-center rounded-full transition-colors duration-150 ease-out"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="px-5 pb-3">
              <div className="flex items-center gap-3">
                <Avatar className="size-12">
                  <AvatarFallback
                    className={`text-sm font-bold ${TONE_SOLID[toneFor(contact.name || contact.phone)]}`}
                  >
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-xl font-extrabold tracking-[-0.01em]">
                    {contact.name || t('unnamed')}
                  </h2>
                  <button
                    onClick={copyPhone}
                    className="text-muted-foreground hover:text-foreground mt-0.5 flex cursor-pointer items-center gap-1 text-xs transition-colors"
                  >
                    <Phone className="size-3" />
                    {contactHandle(contact)}
                    {copiedPhone ? (
                      <Check className="size-3" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTemplatePickerOpen(true)}
                  disabled={sendingTemplate}
                >
                  {sendingTemplate ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <LayoutTemplate className="size-4" />
                  )}
                  {t('sendTemplateBtn')}
                </Button>
              </div>
            </div>
            {contactId && <ContactConversations contactId={contactId} />}

            {/* Tabs */}
            <Tabs
              defaultValue="details"
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="border-border mx-4 mt-3 border-b pb-3">
                <div className="relative">
                  {/* The scroll container is a plain div, not TabsList itself —
                    base-ui's Tabs.List didn't forward the ref down to its
                    DOM node reliably, which silently broke overflow
                    detection (the scroll arrows never appeared even though
                    the row was genuinely overflowing). */}
                  <div
                    ref={tabsScrollRef}
                    className="[scrollbar-width:none] overflow-x-auto py-0.5 [&::-webkit-scrollbar]:hidden"
                  >
                    <TabsList variant="pill" className="w-max">
                      <TabsTrigger value="details">
                        {t('tabs.details')}
                      </TabsTrigger>
                      <TabsTrigger value="tags">{t('tabs.tags')}</TabsTrigger>
                      <TabsTrigger value="notes">{t('tabs.notes')}</TabsTrigger>
                      <TabsTrigger value="custom">
                        {t('tabs.custom')}
                      </TabsTrigger>
                      <TabsTrigger value="deals">{t('tabs.deals')}</TabsTrigger>
                    </TabsList>
                  </div>
                  <ScrollEdgeFades
                    canLeft={tabsCanLeft}
                    canRight={tabsCanRight}
                    onLeft={() => tabsScrollByDir(-1)}
                    onRight={() => tabsScrollByDir(1)}
                    fadeFrom="from-card"
                  />
                </div>
              </div>

              {/* Details Tab */}
              <TabsContent
                value="details"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                <div className="space-y-3">
                  <div className="flex flex-col">
                    <InlineField
                      label={t('name')}
                      value={contact.name ?? ''}
                      placeholder={t('unnamed')}
                      onSave={(v) => saveField('name', v)}
                    />
                    <InlineField
                      label={t('phone')}
                      value={contact.phone}
                      inputMode="tel"
                      onSave={(v) => saveField('phone', v)}
                    />
                    <InlineField
                      label={t('email')}
                      value={contact.email ?? ''}
                      placeholder="—"
                      inputMode="email"
                      onSave={(v) => saveField('email', v)}
                    />
                    <InlineField
                      label={t('company')}
                      value={contact.company ?? ''}
                      placeholder="—"
                      onSave={(v) => saveField('company', v)}
                    />
                  </div>

                  {canManageLgpd && (
                    <div className="border-border/50 mt-2 space-y-1.5 border-t pt-3">
                      <Label className="text-muted-foreground text-xs">
                        {t('lgpd.title')}
                      </Label>
                      {contact.anonymized_at ? (
                        <Badge
                          variant="outline"
                          className="text-muted-foreground"
                        >
                          {t('lgpd.anonymizedBadge')}
                        </Badge>
                      ) : (
                        <Button
                          onClick={anonymizeContact}
                          disabled={anonymizing}
                          variant="outline"
                          size="sm"
                          className="w-full border-red-600/40 text-red-600 hover:bg-red-600/10 hover:text-red-600 dark:border-red-400/40 dark:text-red-400"
                        >
                          {anonymizing ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <ShieldOff className="size-3.5" />
                          )}
                          {t('lgpd.anonymizeBtn')}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* Tags Tab */}
              <TabsContent
                value="tags"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                <div className="space-y-3">
                  <p className="text-muted-foreground text-xs">
                    {t('tagsTab.clickTagDesc')}
                  </p>
                  {allTags.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      {t('tagsTab.noTagsAvailable')}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allTags.map((tag) => {
                        const selected = contactTagIds.includes(tag.id);
                        return (
                          <button
                            key={tag.id}
                            onClick={() => toggleTag(tag.id)}
                            disabled={savingTags}
                            className={`inline-flex cursor-pointer items-center rounded-full px-3 py-1 text-xs font-medium transition-all ${
                              selected
                                ? 'ring-primary ring-offset-border ring-2 ring-offset-1'
                                : 'opacity-50 hover:opacity-80'
                            }`}
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {selected && <Check className="mr-1 size-3" />}
                            {tag.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* Notes Tab */}
              <TabsContent
                value="notes"
                className="flex min-h-0 flex-1 flex-col px-4 py-3"
              >
                <div className="mb-3 space-y-2">
                  <Textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder={t('notesTab.placeholder')}
                    className="min-h-[60px] resize-none text-sm"
                  />
                  <Button
                    onClick={addNote}
                    disabled={!newNote.trim() || savingNote}
                    className="bg-foreground hover:bg-foreground/90 text-background"
                    size="sm"
                  >
                    {savingNote ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    {t('notesTab.save')}
                  </Button>
                </div>

                <div className="flex-1 space-y-2 overflow-y-auto">
                  {loadingNotes ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="text-muted-foreground size-5 animate-spin" />
                    </div>
                  ) : notes.length === 0 ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">
                      {t('notesTab.noNotes')}
                    </p>
                  ) : (
                    notes.map((note) => (
                      <div
                        key={note.id}
                        className="bg-muted/50 border-border/50 group rounded-lg border p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-muted-foreground flex-1 text-sm whitespace-pre-wrap">
                            {note.note_text}
                          </p>
                          <button
                            onClick={() => deleteNote(note.id)}
                            className="text-muted-foreground shrink-0 cursor-pointer opacity-0 transition-all group-hover:opacity-100 hover:text-red-400"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <p className="text-muted-foreground mt-1.5 text-xs">
                          {new Date(note.created_at).toLocaleDateString(
                            APP_LOCALE,
                            {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            }
                          )}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>

              {/* Custom Fields Tab */}
              <TabsContent
                value="custom"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                {loadingCustom ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="text-muted-foreground size-5 animate-spin" />
                  </div>
                ) : customFields.length === 0 ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">
                    {t('noCustomFields')}
                  </p>
                ) : (
                  <div className="flex flex-col">
                    {customFields.map((field) => (
                      <InlineField
                        key={field.id}
                        label={field.field_name}
                        value={customValues[field.id] ?? ''}
                        placeholder="—"
                        onSave={(v) => saveCustomField(field.id, v)}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Deals Tab */}
              <TabsContent
                value="deals"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                {loadingDeals ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="text-primary size-5 animate-spin" />
                  </div>
                ) : deals.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {t('dealsTab.noDeals')}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {deals.map((deal) => (
                      <div
                        key={deal.id}
                        className="border-border bg-muted/50 rounded-lg border p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-foreground text-sm font-medium">
                            {deal.title}
                          </p>
                          {deal.stage && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                backgroundColor: `${deal.stage.color}20`,
                                color: deal.stage.color,
                              }}
                            >
                              {deal.stage.name}
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground mt-1.5 flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1">
                            <DollarSign className="size-3" />
                            {formatCurrency(
                              deal.value ?? 0,
                              deal.currency || defaultCurrency
                            )}
                          </span>
                          {deal.status && deal.status !== 'open' && (
                            <span
                              className={
                                deal.status === 'won'
                                  ? 'text-primary'
                                  : 'text-red-600 dark:text-red-400'
                              }
                            >
                              {deal.status}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
            <p className="text-muted-foreground border-border border-t px-5 py-3 text-xs">
              {t('editHint')}
            </p>
          </div>
        )}
      </SidePanel>
      <TemplatePicker
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        onSelect={handleSendTemplate}
      />
    </>
  );
}
