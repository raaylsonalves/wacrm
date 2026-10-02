"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { usePresence } from "@/hooks/use-presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  Profile,
  InteractiveMessagePayload,
} from "@/types";
import {
  MessageSquare,
  ChevronDown,
  UserPlus,
  Check,
  Clock,
  ArrowLeft,
  RefreshCw,
  Search,
  Star,
  X,
  PanelRightOpen,
  PanelRightClose,
} from "lucide-react";
import { format, isToday, isYesterday, differenceInHours } from "date-fns";
import { useTranslations } from "next-intl";
import { dateFnsLocale } from "@/lib/date-fns-locale";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageBubble } from "./message-bubble";
import { DealStageChip } from "./deal-stage-chip";
import { CaseChip } from "./case-chip";
import { OptOutNotice } from "./opt-out-notice";
import { findMatches } from "@/lib/inbox/thread-search";
import { TransferDialog } from "./transfer-dialog";
import { startsRun, unseenCount } from "@/lib/inbox/bubble-runs";
import { MessageActions } from "./message-actions";
import { MediaLightbox } from "./media-lightbox";
import { collectMediaGallery } from "@/lib/media/gallery";
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from "./message-composer";
import { deleteAccountMedia } from "@/lib/storage/upload-media";
import { TemplatePicker } from "./template-picker";
import { AiThreadBanner } from "./ai-thread-banner";
import { buildReplyPreview } from "./reply-quote";
import { renderTemplateBody } from "@/lib/whatsapp/template-body";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { toast } from "sonner";

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null,
  ) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
  /** Tap on the header contact — opens the contact panel (sheet on phones). */
  onOpenContact?: () => void;
}

function formatDateSeparator(dateStr: string, t: ReturnType<typeof useTranslations>): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t("today");
  if (isYesterday(date)) return t("yesterday");
  return format(date, "MMMM d, yyyy", { locale: dateFnsLocale });
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = "";

  for (const msg of messages) {
    const day = format(new Date(msg.created_at), "yyyy-MM-dd");
    if (day !== currentDate) {
      currentDate = day;
      groups.push({ date: msg.created_at, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

const STATUS_OPTIONS: { label: string; value: ConversationStatus; color: string }[] = [
  { label: "Open", value: "open", color: "text-primary" },
  { label: "Pending", value: "pending", color: "text-amber-600 dark:text-amber-400" },
  { label: "Closed", value: "closed", color: "text-muted-foreground" },
];

/**
 * WhatsApp-style doodle background applied to the chat area (both the
 * active thread and the empty state). The SVG tile lives at
 * `/public/inbox-doodle.svg`; the slate-950 colour sits underneath so
 * the doodles read as a subtle pattern rather than a stark grid.
 *
 * Defined once at module scope so the two render paths can't drift —
 * if we ever switch the asset, both spots update together.
 */
const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onAssignChange,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
  onOpenContact,
}: MessageThreadProps) {
  const t = useTranslations("Inbox.messageThread");
  const tTimer = useTranslations("Inbox.sessionTimer");
  const tQuote = useTranslations("Inbox.replyQuote");
  const tComposer = useTranslations("Inbox.composer");

  const { user, accountId } = useAuth();
  const { getPresence, getRow, now } = usePresence();
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // In-conversation search (header magnifier): matches among the loaded
  // messages, stepped with the arrows; the current one gets a ring.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);
  // Personal stars (migration 095) on this conversation's messages, and the
  // "only starred" toggle of the search bar.
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const [starOnly, setStarOnly] = useState(false);
  const matchIds = useMemo(() => {
    if (!searchOpen) return [];
    if (!starOnly) return findMatches(messages, searchQuery);
    const hits = searchQuery.trim().length < 2
      ? null
      : new Set(findMatches(messages, searchQuery));
    return messages
      .filter((m) => starred.has(m.id) && (!hits || hits.has(m.id)))
      .map((m) => m.id);
  }, [searchOpen, starOnly, starred, messages, searchQuery]);
  useEffect(() => {
    const id = matchIds[searchIdx];
    if (id) {
      document
        .getElementById(`msg-${id}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [matchIds, searchIdx]);
  // A different conversation starts with the search closed.
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setStarOnly(false);
  }, [conversation?.id]);
  useEffect(() => {
    const cid = conversation?.id;
    if (!cid || !user?.id) {
      setStarred(new Set());
      return;
    }
    let alive = true;
    createClient()
      .from("message_stars")
      .select("message_id")
      .eq("conversation_id", cid)
      .eq("user_id", user.id)
      .then(({ data }) => {
        if (alive)
          setStarred(new Set((data ?? []).map((r) => r.message_id as string)));
      });
    return () => {
      alive = false;
    };
  }, [conversation?.id, user?.id]);

  async function toggleStar(messageId: string) {
    const cid = conversation?.id;
    if (!cid || !user?.id || !accountId) return;
    const supabase = createClient();
    const was = starred.has(messageId);
    setStarred((prev) => {
      const next = new Set(prev);
      if (was) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
    const { error } = was
      ? await supabase
          .from("message_stars")
          .delete()
          .eq("user_id", user.id)
          .eq("message_id", messageId)
      : await supabase.from("message_stars").insert({
          user_id: user.id,
          message_id: messageId,
          conversation_id: cid,
          account_id: accountId,
        });
    if (error) {
      setStarred((prev) => {
        const next = new Set(prev);
        if (was) next.add(messageId);
        else next.delete(messageId);
        return next;
      });
      toast.error(t("starFailed"));
    }
  }
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Label of the WAHA channel this conversation is pinned to, for the
  // header badge — mirrors ConversationList's row badge (same reason:
  // with multiple connected numbers, "which number is this on" isn't
  // otherwise visible anywhere in the thread). `null` for a Cloud API
  // conversation (whatsapp_channel_id is null) or while it's loading.
  const [channelLabel, setChannelLabel] = useState<string | null>(null);
  useEffect(() => {
    const channelId = conversation?.whatsapp_channel_id;
    if (!channelId) {
      setChannelLabel(null);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    supabase
      .from("whatsapp_waha_channels")
      .select("label")
      .eq("id", channelId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setChannelLabel(data?.label ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversation?.whatsapp_channel_id]);
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);
  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  // Which attachment the media viewer is showing. Lives here rather than in
  // the bubble so the viewer can page through every image/video in the
  // thread (issue #373). Paired with the conversation it belongs to and read
  // back through that check below, so switching threads closes the viewer
  // without an effect racing the messages refetch.
  const [openMedia, setOpenMedia] = useState<{
    conversationId: string;
    messageId: string;
  } | null>(null);

  // Profiles are bounded by RLS to rows the current user is allowed to
  // see — today that's just the current user, but the dropdown keeps the
  // shape ready for shared-team workspaces without a refactor.
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("profiles")
      .select("*")
      .order("full_name")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch profiles:", error);
          return;
        }
        setProfiles((data as Profile[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Which of those profiles this conversation's channel actually
  // allows assigning to (specs/channel-routing-responsibles.md). The
  // trigger in migration 069 is what actually enforces this — this
  // fetch only decides what the dropdown offers, so an ineligible
  // member doesn't appear and then error on click.
  const [eligibility, setEligibility] = useState<{
    restricted: boolean;
    eligibleUserIds: string[];
  } | null>(null);
  useEffect(() => {
    const conversationId = conversation?.id;
    if (!conversationId) {
      setEligibility(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/conversations/${conversationId}/eligible-assignees`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (!cancelled) setEligibility(payload);
      })
      .catch(() => {
        if (!cancelled) setEligibility(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversation?.id]);

  const assignableProfiles =
    eligibility?.restricted
      ? profiles.filter((p) => eligibility.eligibleUserIds.includes(p.user_id))
      : profiles;

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    if (!messages.length) return { expired: false, remaining: "" };

    // Find last customer message
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === "customer");

    if (!lastCustomerMsg) return { expired: true, remaining: tTimer("noCustomerMessages") };

    const hoursSince = differenceInHours(new Date(), new Date(lastCustomerMsg.created_at));
    const expired = hoursSince >= 24;

    if (expired) {
      return { expired: true, remaining: tTimer("expired") };
    }

    const hoursLeft = 24 - hoursSince;
    const remaining =
      hoursLeft >= 1
        ? tTimer("xhRemaining", { hours: Math.floor(hoursLeft) })
        : tTimer("xmRemaining", { minutes: Math.floor(hoursLeft * 60) });

    return { expired, remaining };
  }, [messages, tTimer]);

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  const mediaMessageId =
    openMedia && openMedia.conversationId === conversationId
      ? openMedia.messageId
      : null;
  const handleMediaChange = useCallback(
    (messageId: string | null) => {
      setOpenMedia(
        messageId && conversationId ? { conversationId, messageId } : null,
      );
    },
    [conversationId],
  );

  // Fetch messages whenever the selected conversation changes. Kept
  // separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
  useEffect(() => {
    if (!conversationId) return;

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      setLoading(true);

      // Fetch the most recent messages, not the oldest: with no limit,
      // PostgREST's own row cap (1000 by default) still applies
      // server-side, and combined with `ascending: true` that silently
      // cut off the newest messages on any conversation past that
      // size — the customer's latest replies just weren't there.
      // Ordering descending-with-limit then reversing gets the tail of
      // the conversation instead of the head. No "load older messages"
      // UI exists yet for anything beyond this window.
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(500);

      if (cancelled) return;

      if (error) {
        console.error("Failed to fetch messages:", error);
      } else {
        onMessagesLoadedRef.current((data ?? []).slice().reverse());
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [conversationId, resyncToken]);

  // Reactions fetch — pulls the current state from the DB. Kept separate
  // from the channel subscription below so a `resyncToken` bump just
  // refetches the rows without also tearing down and rebuilding the
  // realtime channel.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("message_reactions")
        .select("*")
        .eq("conversation_id", conversationId);
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch reactions:", error);
        return;
      }
      setReactions((data as MessageReaction[]) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // Reactions realtime subscription per conversation. Subscribing here
  // (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox.
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();

    const channel = supabase
      .channel(`reactions:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            // Swap any matching optimistic temp row for the real one so
            // the pill doesn't double up after a successful POST.
            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith("temp-") &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id,
            );
            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }
            return [...prev, row];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;
          if (!old?.id) return;
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    const supabase = createClient();
    supabase
      .from("conversations")
      .update({ unread_count: 0 })
      .eq("id", conversationId)
      .then(({ error }) => {
        if (error) console.error("Failed to reset unread_count:", error);
      });
  }, [conversationId, hasUnread]);

  // Follow new messages only while the agent is at the bottom (or just
  // sent one) — scrolled up reading history, they get the "jump to
  // latest" button with a count instead of being yanked down.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [seenCount, setSeenCount] = useState(0);
  useEffect(() => {
    atBottomRef.current = true;
  }, [conversationId]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    const ownSend = !!last && last.id.startsWith("temp-");
    if (atBottomRef.current || ownSend) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setSeenCount(messages.length);
  }, [messages.length]);
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);
  const unseen = atBottom ? 0 : unseenCount(messages, seenCount);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;

      // Optimistic update — shows the message immediately with "sending" status
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "text",
        content_text: text,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "text",
            content_text: text,
            reply_to_message_id: replyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send message:", reason);
          toast.error(t("sendFailed", { reason }));
          // Mark the optimistic bubble as failed so the user sees what happened
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send message:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(t("sendFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === "document"
          ? payload.caption || payload.filename || "Document"
          : payload.caption;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error("Failed to send media:", reason);
          toast.error(t("sendFailed", { reason }));
          onUpdateMessage(tempId, { status: "failed" });
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send media:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(t("sendFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t],
  );

  const handleSendInteractive = useCallback(
    async (payload: InteractiveMessagePayload, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;
      // Optimistic bubble — renders the buttons/list immediately via the
      // interactive_payload, same as the persisted row will.
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "interactive",
        content_text: payload.body,
        interactive_payload: payload,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "interactive",
            interactive_payload: payload,
            reply_to_message_id: replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error("Failed to send interactive message:", reason);
          toast.error(t("sendFailed", { reason }));
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send interactive message:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(t("sendFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t],
  );

  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      const supabase = createClient();
      await supabase
        .from("conversations")
        .update({ status })
        .eq("id", conversation.id);

      onStatusChange(conversation.id, status);
    },
    [conversation, onStatusChange]
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
      },
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "template",
        content_text: renderedBody,
        template_name: template.name,
        status: "sending",
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "template",
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the new send-builder path
            // (header media + URL button substitution). Body values
            // are mirrored under both shapes so the route can fall
            // back if the template row isn't found locally.
            template_message_params: {
              body: values.body,
              headerText: values.headerText,
              buttonParams: values.buttonParams,
            },
            template_params: values.body,
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send template:", reason);
          toast.error(t("sendTemplateFailed", { reason }));
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send template:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(t("sendTemplateFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t],
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Images + videos in the thread, in order — the set the media viewer
  // pages through with ← / →.
  const mediaGallery = useMemo(() => collectMediaGallery(messages), [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  const contactDisplayName =
    contact?.name || (contact ? contactHandle(contact) : "") || t("customer");

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg =
        m.sender_type === "agent" || m.sender_type === "bot";
      return isAgentMsg ? "You" : contactDisplayName;
    },
    [contactDisplayName],
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
      });
    },
    [authorLabelFor],
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn("[reactions] missing user or conversation");
        return;
      }
      if (messageId.startsWith("temp-")) {
        toast.error(t("waitForSending"));
        return;
      }

      const convId = conversation.id;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === "agent" &&
            r.actor_id === userId,
        );
        if (emoji === "") return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: "agent",
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch("/api/whatsapp/react", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(t("reactionFailed", { reason }));
        setReactions(snapshot);
      }
    },
    [conversation, user?.id, t],
  );

  const [transferTo, setTransferTo] = useState<{ user_id: string; full_name: string } | null>(null);

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({ assigned_agent_id: agentId })
        .eq("id", conversation.id);

      if (error) {
        console.error("Failed to update assignment:", error);
        toast.error(t("assignmentUpdateFailed"));
        return;
      }

      onAssignChange(conversation.id, agentId);
    },
    [conversation, onAssignChange, t],
  );

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div className={cn("flex flex-1 flex-col items-center justify-center", DOODLE_BG_CLASSES)}>
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-sm font-medium text-muted-foreground">
          {t("selectConversation")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("selectConversationHint")}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contactHandle(contact);
  const messageGroups = groupMessagesByDate(messages);
  const currentStatus = STATUS_OPTIONS.find(
    (s) => s.value === conversation.status
  );
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? t("assigned"))
    : t("assign");

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div className={cn("flex min-w-0 flex-1 flex-col", DOODLE_BG_CLASSES)}>
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-3 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t("backToConversations")}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          {/* Tap the photo or the name for the contact panel (a bottom
              sheet on phones). The stage chip is its own menu, so it sits
              on the line under the name rather than inside the button —
              and the name keeps its width on a narrow phone. */}
          <button
            type="button"
            onClick={onOpenContact}
            disabled={!onOpenContact}
            aria-label={t("showContact")}
            className="shrink-0 rounded-full"
          >
            {contact?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={contact.avatar_url}
                alt=""
                className="h-9 w-9 flex-shrink-0 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
          </button>
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onOpenContact}
              disabled={!onOpenContact}
              className="flex max-w-full min-w-0 items-center gap-1.5 text-left"
            >
              <h2 className="truncate text-sm font-semibold text-foreground">{displayName}</h2>
              {channelLabel && (
                <span
                  title={channelLabel}
                  className="bg-muted text-muted-foreground shrink-0 truncate rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium"
                >
                  {channelLabel}
                </span>
              )}
            </button>
            <div className="flex min-w-0 items-center gap-1.5">
              <DealStageChip contactId={contact?.id} />
              <CaseChip conversationId={conversation?.id} />
              {contact?.id && (
                <OptOutNotice
                  key={contact.id}
                  contactId={contact.id}
                  optedOutAt={contact.opted_out_at}
                  variant="chip"
                />
              )}
              <p className="hidden truncate text-xs text-muted-foreground sm:block">
                {contactHandle(contact)}
              </p>
            </div>
          </div>
          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room. This is Meta's own
              24h customer-service-window rule (once the window closes,
              only approved templates can be sent), not a wacrm setting
              — the tooltip exists so agents don't go looking for it in
              Settings. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge
                  variant="outline"
                  className={cn(
                    "ml-1 hidden shrink-0 gap-1 border-border text-[10px] sm:ml-2",
                    // The contact panel eats the width this badge would
                    // otherwise have room in (issue: this same trio of
                    // controls — badge, status dropdown, assign dropdown
                    // — visually overlapped at ~1024-1280px with the
                    // panel open). Give it a later breakpoint than the
                    // panel-closed case instead of fighting for space.
                    contactPanelOpen ? "xl:inline-flex" : "sm:inline-flex",
                    sessionInfo.expired ? "text-red-600 dark:text-red-400" : "text-primary"
                  )}
                />
              }
            >
              <Clock className="h-3 w-3" />
              {sessionInfo.remaining}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs text-left">
              {tTimer("explainerTooltip")}
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? t("hideContactPanel") : t("showContactPanel")
              }
              title={contactPanelOpen ? t("hideContact") : t("showContact")}
              aria-pressed={contactPanelOpen}
              className={cn(
                "hidden h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground lg:inline-flex",
                contactPanelOpen ? "text-primary" : "text-muted-foreground",
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setSearchOpen((o) => !o);
              setSearchQuery("");
            }}
            aria-pressed={searchOpen}
            aria-label={t("searchInChat")}
            title={t("searchInChat")}
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground",
              searchOpen ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Search className="h-3.5 w-3.5" />
          </button>

          {/* Manual refresh — forces a refetch of the messages + the
              conversation list (the parent bumps its resyncToken). Useful
              when realtime missed an event or the agent just wants to be
              sure nothing's stale. Only rendered when the parent wires
              up `onRefresh`. */}
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label={t("refreshConversation")}
              title={t("refresh")}
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60",
              )}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
              />
            </button>
          )}

          {/* Status dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(
                  "inline-flex shrink-0 items-center justify-center h-7 gap-1 px-2 text-xs whitespace-nowrap rounded-md hover:bg-muted",
                  currentStatus?.color ?? "text-muted-foreground"
                )}>
                {currentStatus ? t(`status${currentStatus.label}`) : t("status")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {STATUS_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => handleStatusChange(opt.value)}
                  className={cn("text-sm", opt.color)}
                >
                  {t(`status${opt.label}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Assign dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex shrink-0 items-center justify-center h-7 gap-1 px-2 text-xs whitespace-nowrap rounded-md hover:bg-muted",
                assignedAgentId ? "text-primary" : "text-muted-foreground"
              )}
            >
              <UserPlus className="h-3 w-3" />
              <span className="hidden sm:inline">{assignLabel}</span>
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {assignableProfiles.length === 0 ? (
                <DropdownMenuItem disabled className="text-sm text-muted-foreground">
                  {eligibility?.restricted ? t("noResponsibles") : t("noTeammates")}
                </DropdownMenuItem>
              ) : (
                assignableProfiles.map((p) => {
                  const isSelected = p.user_id === assignedAgentId;
                  const presence = getPresence(p.user_id);
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() =>
                        // Handing it to someone else asks for a note;
                        // taking it yourself (or re-picking the owner) is direct.
                        p.user_id === user?.id || isSelected
                          ? handleAssignChange(p.user_id)
                          : setTransferTo({ user_id: p.user_id, full_name: p.full_name })
                      }
                      className={cn(
                        "text-sm",
                        isSelected ? "text-primary" : "text-popover-foreground"
                      )}
                    >
                      <PresenceDot
                        status={presence}
                        label={presenceLabel(
                          presence,
                          getRow(p.user_id)?.last_seen_at ?? null,
                          now
                        )}
                        className="mr-2"
                      />
                      <span className="flex-1">
                        {p.full_name}
                        {p.user_id === user?.id ? t("me") : ""}
                      </span>
                      {isSelected && <Check className="ml-2 h-3 w-3" />}
                    </DropdownMenuItem>
                  );
                })
              )}
              {assignedAgentId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    onClick={() => handleAssignChange(null)}
                    className="text-sm text-muted-foreground"
                  >
                    {t("unassign")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {searchOpen && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearchOpen(false);
              if (e.key === "Enter" && matchIds.length > 0) {
                e.preventDefault();
                setSearchIdx((i) =>
                  (i + (e.shiftKey ? -1 : 1) + matchIds.length) % matchIds.length,
                );
              }
            }}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="min-w-0 flex-1 rounded-sm bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <button
            type="button"
            onClick={() => {
              setStarOnly((v) => !v);
              setSearchIdx(0);
            }}
            aria-pressed={starOnly}
            aria-label={t("searchStarredOnly")}
            title={t("searchStarredOnly")}
            className={cn(
              "rounded p-1 hover:bg-muted",
              starOnly ? "text-amber-500" : "text-muted-foreground",
            )}
          >
            <Star className={cn("h-4 w-4", starOnly && "fill-amber-400")} />
          </button>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {searchQuery.trim().length < 2 && !starOnly
              ? ""
              : matchIds.length === 0
                ? t("searchNoResults")
                : `${searchIdx + 1}/${matchIds.length}`}
          </span>
          <button
            type="button"
            disabled={matchIds.length === 0}
            onClick={() =>
              setSearchIdx((i) => (i - 1 + matchIds.length) % matchIds.length)
            }
            aria-label={t("searchPrev")}
            className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            <ChevronDown className="h-4 w-4 rotate-180" />
          </button>
          <button
            type="button"
            disabled={matchIds.length === 0}
            onClick={() => setSearchIdx((i) => (i + 1) % matchIds.length)}
            aria-label={t("searchNext")}
            className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(false)}
            aria-label={t("searchClose")}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Messages Area */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="chat-wallpaper flex-1 overflow-y-auto px-4 py-4 sm:px-10"
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{t("noMessagesYet")}</p>
            <p className="text-xs text-muted-foreground">
              {t("sendTemplateHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messageGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="sticky top-0 z-[1] mb-3 flex items-center justify-center">
                  <span className="rounded-lg bg-card px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                    {formatDateSeparator(group.date, t)}
                  </span>
                </div>
                {/* Messages */}
                <div>
                  {group.messages.map((msg, i) => {
                    const runStart = startsRun(group.messages[i - 1], msg);
                    const parent = msg.reply_to_message_id
                      ? messagesById.get(msg.reply_to_message_id)
                      : null;
                    const reply = parent
                      ? {
                          authorLabel:
                            parent.sender_type === "agent" || parent.sender_type === "bot"
                              ? t("me") 
                              : contact?.name || contact?.phone || t("unknown"),
                          preview: buildReplyPreview(parent, tQuote),
                        }
                      : null;
                    const msgReactions = reactionsByMessageId.get(msg.id);
                    // Toggle is computed at the call site — `msgReactions`
                    // and `user?.id` are already in scope, no extra hook.
                    const handlePillToggle = (emoji: string) => {
                      const own = msgReactions?.find(
                        (r) =>
                          r.actor_type === "agent" &&
                          r.actor_id === user?.id,
                      );
                      const next = own?.emoji === emoji ? "" : emoji;
                      void postReaction(msg.id, next);
                    };
                    return (
                      <div
                        key={msg.id}
                        id={`msg-${msg.id}`}
                        className={cn(
                          i === 0 ? "" : runStart ? "mt-3" : "mt-0.5",
                          searchOpen && matchIds[searchIdx] === msg.id &&
                            "rounded-lg ring-2 ring-primary/60",
                        )}
                      >
                      <MessageActions
                        message={msg}
                        onReply={() => handleStartReply(msg)}
                        onReact={(emoji) => {
                          if (emoji) void postReaction(msg.id, emoji);
                        }}
                        starred={starred.has(msg.id)}
                        onStar={() => void toggleStar(msg.id)}
                      >
                        <MessageBubble
                          message={msg}
                          reply={reply}
                          reactions={msgReactions}
                          currentUserId={user?.id}
                          onToggleReaction={handlePillToggle}
                          onOpenMedia={handleMediaChange}
                          tail={runStart}
                        />
                      </MessageActions>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {!atBottom && messages.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label={tComposer("jumpToLatest")}
          title={tComposer("jumpToLatest")}
          className="absolute right-4 bottom-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-card text-muted-foreground shadow-md ring-1 ring-border hover:text-foreground"
        >
          <ChevronDown className="h-5 w-5" />
          {unseen > 0 && (
            <span className="absolute -top-1.5 -right-1 min-w-5 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-5 text-primary-foreground tabular-nums">
              {unseen > 99 ? "99+" : unseen}
            </span>
          )}
        </button>
      )}
      </div>

      {/* AI auto-reply banner — take over an active bot, or resume it
          after a handoff. Renders nothing unless the account has
          auto-reply configured. */}
      <AiThreadBanner
        conversationId={conversation.id}
        disabled={conversation.ai_autoreply_disabled ?? false}
        handoffSummary={conversation.ai_handoff_summary}
        handoffReason={conversation.ai_handoff_reason}
        handoffMeta={conversation.ai_handoff_meta}
        customerNotified={conversation.ai_handoff_customer_notified}
        noticeSkippedReason={conversation.ai_handoff_notice_skipped_reason}
        assignedAgentId={assignedAgentId}
        currentUserId={user?.id}
        onChange={(patch) => {
          if ("assigned_agent_id" in patch) {
            onAssignChange(conversation.id, patch.assigned_agent_id ?? null);
          }
        }}
      />

      <TransferDialog
        conversationId={conversation.id}
        target={transferTo}
        onClose={() => setTransferTo(null)}
        onAssign={(userId) => handleAssignChange(userId)}
      />

      {/* Composer */}
      <MessageComposer
        conversationId={conversation.id}
        sessionExpired={sessionInfo.expired}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onSendInteractive={handleSendInteractive}
        onOpenTemplates={handleOpenTemplates}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
      />

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />

      {/* Full-size viewer for the thread's images/videos. Renders nothing
          until a bubble opens it. */}
      <MediaLightbox
        items={mediaGallery}
        activeId={mediaMessageId}
        onActiveIdChange={handleMediaChange}
        contactLabel={contactDisplayName}
      />
    </div>
  );
}
