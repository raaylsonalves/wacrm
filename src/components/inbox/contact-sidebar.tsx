"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { APP_LOCALE } from "@/lib/currency";
import { cn } from "@/lib/utils";
import type { Contact, Deal, ContactNote, Tag } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { dateFnsLocale } from "@/lib/date-fns-locale";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { ConversationNotes } from "./conversation-notes";
import { ConversationSummaryCard } from "./conversation-summary";
import { TONE_SOLID, toneFor } from "@/lib/tones";
import { OptOutNotice } from "./opt-out-notice";

interface ContactSidebarProps {
  contact: Contact | null;
  /** Active thread — enables the internal-notes section (migration 070). */
  conversationId?: string | null;
  /** "sheet": full-width inside the mobile bottom sheet — no border,
   *  no drag handle, no fixed width. */
  variant?: "panel" | "sheet";
}

// Drag-resizable width (spec: inbox-contact-panel-sizing.md). 280px
// (`w-70`) was the old fixed width — kept as the default so nobody's
// layout jumps on first load after this shipped.
const PANEL_WIDTH_KEY = "wacrm.inboxContactPanelWidth";
const MIN_PANEL_WIDTH = 240;
const MAX_PANEL_WIDTH = 420;
const DEFAULT_PANEL_WIDTH = 280;

function clampPanelWidth(px: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, px));
}

function readInitialPanelWidth(): number {
  if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampPanelWidth(stored);
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
  }
  return DEFAULT_PANEL_WIDTH;
}


// v2 contact column: each block is its own card on the page background.
const CARD = "rounded-[22px] border border-border bg-card p-4";
const SECTION_TITLE = "flex items-center gap-2 text-xs font-bold text-muted-foreground";

export function ContactSidebar({ contact, conversationId, variant = "panel" }: ContactSidebarProps) {
  const sheet = variant === "sheet";
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId } = useAuth();

  const [panelWidth, setPanelWidth] = useState(readInitialPanelWidth);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  // Drag-to-resize — grabs the handle on the panel's left edge. Resizing
  // shrinks the thread pane, not this one growing over it, since the
  // handle is dragged leftward to widen (mirrors how the OS/browser
  // itself resizes a right-docked panel).
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: panelWidth };
      const onMove = (moveEvent: PointerEvent) => {
        if (!dragState.current) return;
        const delta = dragState.current.startX - moveEvent.clientX;
        setPanelWidth(clampPanelWidth(dragState.current.startWidth + delta));
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setPanelWidth((w) => {
          try {
            localStorage.setItem(PANEL_WIDTH_KEY, String(w));
          } catch {
            // Same private-browsing edge case as above — the in-memory
            // width still applies for the rest of this session.
          }
          return w;
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [panelWidth],
  );

  const ResizeHandle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={tSidebar("resizePanel")}
      onPointerDown={onHandlePointerDown}
      // Hit area is wider than the visible line (8px vs. the 1.5px
      // highlight) — a resize handle exactly as thin as its highlight
      // is nearly impossible to grab precisely with a mouse.
      className="group absolute top-0 left-0 z-10 h-full w-2 -translate-x-1/2 cursor-col-resize touch-none"
    >
      <div className="mx-auto h-full w-[3px] group-hover:bg-primary/30 group-active:bg-primary/40" />
    </div>
  );
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, and tags in parallel
    const [dealsRes, notesRes, tagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    // Copies whatever the row displays — a BSUID-only contact has no
    // phone number to copy, but its @username still identifies them.
    const handle = contact ? contactHandle(contact) : '';
    if (!handle) return;
    await navigator.clipboard.writeText(handle);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div
        className="relative flex h-full shrink-0 items-center justify-center rounded-3xl border border-border bg-card"
        style={{ width: panelWidth }}
      >
        {ResizeHandle}
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contactHandle(contact);
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div
      className={cn(
        "relative flex h-full shrink-0 flex-col",
        sheet && "w-full bg-card",
      )}
      style={sheet ? undefined : { width: panelWidth }}
    >
      {!sheet && ResizeHandle}
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("flex flex-col gap-3", sheet && "p-4")}>
          <div className={cn(CARD, "p-[18px]")}>
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className={cn("flex h-16 w-16 items-center justify-center overflow-hidden rounded-full text-xl font-bold", TONE_SOLID[toneFor(displayName)])}>
              {contact.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- contact avatars come from arbitrary hosts; next/image would need every one allow-listed
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-2.5 text-base font-bold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
            <OptOutNotice
              key={contact.id}
              contactId={contact.id}
              optedOutAt={contact.opted_out_at}
            />
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">
                {contactHandle(contact)}
              </span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          </div>

          {/* Tags */}
          <div className={CARD}>
            <div className={SECTION_TITLE}>
              <TagIcon className="h-3 w-3" />
              {tSidebar("tags")}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    title={tag.name}
                    className="inline-block max-w-[160px] truncate align-middle rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Active Deals */}
          <div className={CARD}>
            <div className={SECTION_TITLE}>
              <DollarSign className="h-3 w-3" />
              {tSidebar("deals")}
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-2xl bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString(APP_LOCALE)}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {conversationId && (
            <>
              <ConversationSummaryCard
                key={`summary-${conversationId}`}
                conversationId={conversationId}
              />
              <div className={CARD}>
                <ConversationNotes
                  key={conversationId}
                  conversationId={conversationId}
                />
              </div>
            </>
          )}

          {/* Notes */}
          <div className={CARD}>
            <div className={SECTION_TITLE}>
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-2xl border border-border bg-card-2 px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-foreground/30"
                />
                <Button
                  size="sm"
                  className="h-auto rounded-xl px-2"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-2xl bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm", { locale: dateFnsLocale })}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
