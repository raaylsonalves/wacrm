'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  CONVERSATION_SELECT,
  isSnoozed,
  matchesContactFilters,
  snoozePresetUntil,
  type SnoozePreset,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { slaTier, formatElapsedMinutes, type SlaTier } from '@/lib/inbox/sla';
import {
  policiesToMap,
  eligibleAssigneesFromMap,
  type ChannelPolicyEntry,
} from '@/lib/channels/routing';
import type { Conversation, ConversationStatus, Profile, Tag } from '@/types';
import {
  Bot,
  Search,
  ChevronDown,
  X,
  Check,
  Loader2,
  Clock,
  AlarmClock,
  Hash,
  CalendarClock,
  CornerUpLeft,
  Hourglass,
} from 'lucide-react';
import { format, formatDistanceToNow, isToday, isTomorrow } from 'date-fns';
import {
  earliestByContact,
  workQueueOf,
  type UpcomingAppointment,
  type WorkQueue,
} from '@/lib/inbox/work-queue';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  COMMAND_DOT,
  commandOf,
  formatSpan,
  initialsOf,
  windowState,
} from '@/lib/inbox/signals';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { neighborId, useInboxShortcuts } from '@/hooks/use-inbox-shortcuts';

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /**
   * Row-level context menu actions (specs/inbox-context-menu-actions.md)
   * mirror MessageThread's own status/assign handlers — same signature,
   * so the parent's existing local-state patch works for either origin.
   * All optional so a caller that doesn't need the context menu (none
   * today, but keeps the component's public surface backward-compatible)
   * doesn't have to wire them.
   */
  onStatusChange?: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange?: (
    conversationId: string,
    assignedAgentId: string | null
  ) => void;
  onContactTagsChange?: (contactId: string, tags: Tag[]) => void;
  /** Local-state patch for snooze / conversation tags (migration 070). */
  onConversationPatch?: (
    conversationId: string,
    patch: Partial<Conversation>
  ) => void;
}

const STATUS_LABEL_KEY: Record<ConversationStatus, string> = {
  open: 'statusOpen',
  pending: 'statusPending',
  closed: 'statusClosed',
};

type InboxFilter = ConversationStatus | 'all' | 'unread' | 'snoozed' | 'waiting_human';

const SNOOZE_PRESETS: SnoozePreset[] = ['1h', '3h', 'tomorrow'];

interface WahaChannelOption {
  id: string;
  label: string;
}

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onStatusChange,
  onAssignChange,
  onContactTagsChange,
  onConversationPatch,
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');
  const tThread = useTranslations('Inbox.messageThread');
  const { responseTimeTargetMinutes, accountId } = useAuth();

  // Whether the account has an AI answering at all, asked ONCE for the
  // whole list (not per row). Unknown until it loads, and a row then
  // doesn't claim the AI is answering (see commandOf).
  const [aiOn, setAiOn] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    createClient()
      .from('ai_configs')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .eq('auto_reply_enabled', true)
      .limit(1)
      .then(({ data, error }) => {
        if (alive && !error) setAiOn((data ?? []).length > 0);
      });
    return () => {
      alive = false;
    };
  }, [accountId]);

  // Upcoming appointments, one query for the whole list — they put a
  // conversation in the "Scheduled" queue and on its next-action line.
  const [appointments, setAppointments] = useState<Map<string, UpcomingAppointment>>(
    () => new Map()
  );
  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    createClient()
      .from('appointments')
      .select('contact_id, starts_at, title')
      .eq('account_id', accountId)
      .in('status', ['scheduled', 'confirmed'])
      .gte('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(500)
      .then(({ data, error }) => {
        if (alive && !error) setAppointments(earliestByContact((data ?? []) as UpcomingAppointment[]));
      });
    return () => {
      alive = false;
    };
  }, [accountId]);

  // specs/inbox-response-time-sla.md — the per-row "waiting Xm" badge
  // needs to advance even when nothing else re-renders the list (no
  // new message, no status change). A single interval here (not one
  // per row) re-renders every row's elapsed time together, mirroring
  // the dashboard's own periodic-refresh precedent rather than adding
  // a timer per conversation.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(
    () => [
      { label: t('filterAll'), value: 'all' },
      { label: t('filterUnread'), value: 'unread' },
      { label: t('filterWaitingHuman'), value: 'waiting_human' },
      { label: t('filterOpen'), value: 'open' },
      { label: t('filterPending'), value: 'pending' },
      { label: t('filterClosed'), value: 'closed' },
      { label: t('filterSnoozed'), value: 'snoozed' },
    ],
    [t]
  );

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [queue, setQueue] = useState<WorkQueue | null>(null);
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // Channel filter (specs/waha-channel-connection.md) — 'all' is the
  // no-op default, 'cloud_api' matches conversations whose
  // whatsapp_channel_id is null (the account's Meta number), and any
  // other value is a whatsapp_waha_channels id.
  const [wahaChannels, setWahaChannels] = useState<WahaChannelOption[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string>('all');

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      // Ordered most-recent-first, so PostgREST's own row cap (1000 by
      // default) drops the oldest/least-active conversations rather
      // than the ones an agent actually needs to see — the safe
      // direction to truncate in. Explicit for clarity; there's no
      // "load more" UI yet for an account past this size.
      const { data, error } = await supabase
        .from('conversations')
        .select(CONVERSATION_SELECT)
        .order('last_message_at', { ascending: false })
        .limit(1000);

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error('Failed to fetch conversations:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('tags').select('*').order('name');
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Channel labels for the filter picker and per-row badge — only
  // fetched to know whether the account has any WAHA channels at all;
  // both UI pieces stay hidden when it's Cloud-API-only (nothing to
  // disambiguate).
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('whatsapp_waha_channels')
        .select('id, label')
        .order('label');
      if (!cancelled && data) setWahaChannels(data as WahaChannelOption[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Teammates for the context menu's "assign" submenu — same query
  // MessageThread runs for its own assign dropdown (see that file for
  // why it's a plain, RLS-scoped select rather than a members endpoint).
  const [profiles, setProfiles] = useState<Profile[]>([]);
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    supabase
      .from('profiles')
      .select('*')
      .order('full_name')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Failed to fetch profiles:', error);
          return;
        }
        setProfiles((data as Profile[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-channel routing policy, fetched once for the whole list rather
  // than per row (specs/channel-routing-responsibles.md) — a row's
  // eligible-assignee set is a pure lookup against this map, no
  // per-conversation round trip.
  const [routingPolicyMap, setRoutingPolicyMap] = useState<Map<string, string[]>>(
    new Map()
  );
  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/channel-routing')
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (cancelled || !payload) return;
        const entries: ChannelPolicyEntry[] = (payload.channels ?? [])
          .filter((c: { restricted: boolean }) => c.restricted)
          .map((c: { channelId: string | null; responsibleUserIds: string[] }) => ({
            channelId: c.channelId,
            responsibleUserIds: c.responsibleUserIds,
          }));
        setRoutingPolicyMap(policiesToMap(entries));
      })
      .catch(() => {
        /* unrestricted fallback — an empty map means every channel is
           treated as unrestricted, same as the account never having
           configured this feature. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRowStatusChange = useCallback(
    async (conversationId: string, status: ConversationStatus) => {
      const supabase = createClient();
      const { error } = await supabase
        .from('conversations')
        .update({ status })
        .eq('id', conversationId);
      if (error) {
        console.error('Failed to update status:', error);
        toast.error(tThread('assignmentUpdateFailed'));
        return;
      }
      onStatusChange?.(conversationId, status);
    },
    [onStatusChange, tThread]
  );

  const handleRowAssignChange = useCallback(
    async (conversationId: string, agentId: string | null) => {
      const supabase = createClient();
      const { error } = await supabase
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('id', conversationId);
      if (error) {
        console.error('Failed to update assignment:', error);
        toast.error(tThread('assignmentUpdateFailed'));
        return;
      }
      onAssignChange?.(conversationId, agentId);
    },
    [onAssignChange, tThread]
  );

  const handleRowSnooze = useCallback(
    async (conversationId: string, until: Date | null) => {
      const snoozed_until = until ? until.toISOString() : null;
      const supabase = createClient();
      const { error } = await supabase
        .from('conversations')
        .update({ snoozed_until })
        .eq('id', conversationId);
      if (error) {
        console.error('Failed to snooze:', error);
        toast.error(t('snoozeFailed'));
        return;
      }
      onConversationPatch?.(conversationId, { snoozed_until });
      if (until) toast.success(t('snoozed'));
    },
    [onConversationPatch, t]
  );

  const handleRowToggleConversationTag = useCallback(
    async (conversationId: string, currentTags: Tag[], tag: Tag) => {
      const supabase = createClient();
      const hasTag = currentTags.some((ct) => ct.id === tag.id);
      const { error } = hasTag
        ? await supabase
            .from('conversation_tags')
            .delete()
            .eq('conversation_id', conversationId)
            .eq('tag_id', tag.id)
        : await supabase
            .from('conversation_tags')
            .insert({ conversation_id: conversationId, tag_id: tag.id });
      if (error) {
        console.error('Failed to update conversation tag:', error);
        toast.error(t('tagUpdateFailed'));
        return;
      }
      onConversationPatch?.(conversationId, {
        tags: hasTag
          ? currentTags.filter((ct) => ct.id !== tag.id)
          : [...currentTags, tag],
      });
    },
    [onConversationPatch, t]
  );

  const handleRowClearHistory = useCallback(
    async (conversationId: string) => {
      const res = await fetch(
        `/api/conversations/${conversationId}/messages`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        console.error('Failed to clear conversation history:', await res.text());
        toast.error(t('clearHistoryFailed'));
        return;
      }
      toast.success(t('clearHistorySuccess'));
      // The delete + the conversation's own field reset both land via
      // the existing Postgres realtime subscriptions (same as any other
      // agent's edit) — no local state patch needed here.
    },
    [t]
  );

  const handleRowToggleTag = useCallback(
    async (contactId: string, currentTags: Tag[], tag: Tag) => {
      const hasTag = currentTags.some((t) => t.id === tag.id);
      const res = await fetch(`/api/contacts/${contactId}/tags`, {
        method: hasTag ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_id: tag.id }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('tagUpdateFailed'));
        return;
      }
      const nextTags = hasTag
        ? currentTags.filter((t) => t.id !== tag.id)
        : [...currentTags, tag];
      onContactTagsChange?.(contactId, nextTags);
    },
    [onContactTagsChange, t]
  );

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const wahaChannelsById = useMemo(() => {
    const m = new Map<string, WahaChannelOption>();
    for (const c of wahaChannels) m.set(c.id, c);
    return m;
  }, [wahaChannels]);

  // Which to-do queue each conversation sits in (reply / waiting /
  // scheduled), computed once per render for the tabs and the rows.
  const queueById = useMemo(() => {
    const map = new Map<string, WorkQueue | null>();
    for (const c of conversations) {
      map.set(
        c.id,
        workQueueOf({
          command: commandOf({
            status: c.status,
            assignedAgentId: c.assigned_agent_id,
            aiAutoreplyDisabled: c.ai_autoreply_disabled,
            aiOn,
          }),
          snoozed: isSnoozed(c, nowTick),
          lastSenderType: c.last_message_sender_type,
          lastMessageAt: c.last_message_at,
          nextAppointmentAt: c.contact_id ? appointments.get(c.contact_id)?.starts_at : null,
          now: nowTick,
        })
      );
    }
    return map;
  }, [conversations, aiOn, appointments, nowTick]);
  const queueCounts = useMemo(() => {
    const counts: Record<WorkQueue, number> = { reply: 0, waiting: 0, scheduled: 0 };
    for (const q of queueById.values()) if (q) counts[q] += 1;
    return counts;
  }, [queueById]);

  const filtered = useMemo(() => {
    let result = conversations;
    if (queue) result = result.filter((c) => queueById.get(c.id) === queue);

    // Snoozed threads live only under their own filter. `nowTick`
    // advancing is what makes an expired snooze reappear, no cron.
    if (filter === 'snoozed') {
      result = result.filter((c) => isSnoozed(c, nowTick));
    } else {
      result = result.filter((c) => !isSnoozed(c, nowTick));
    }

    if (filter === 'unread') {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter === 'waiting_human') {
      // The AI stopped (hand-off / pause) and no person took it yet — the
      // amber dot on the avatar.
      result = result.filter(
        (c) => c.status !== 'closed' && !c.assigned_agent_id && !!c.ai_autoreply_disabled
      );
    } else if (filter !== 'all' && filter !== 'snoozed') {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (selectedChannel !== 'all') {
      result = result.filter((c) =>
        selectedChannel === 'cloud_api'
          ? !c.whatsapp_channel_id
          : c.whatsapp_channel_id === selectedChannel
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? '';
        const phone = c.contact?.phone?.toLowerCase() ?? '';
        const lastMsg = c.last_message_text?.toLowerCase() ?? '';
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [
    conversations,
    filter,
    queue,
    queueById,
    nowTick,
    search,
    selectedTagIds,
    selectedCompany,
    selectedChannel,
  ]);

  // Keyboard shortcuts act on the list exactly as filtered on screen.
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [snoozeDialogOpen, setSnoozeDialogOpen] = useState(false);
  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId]
  );
  const stepConversation = (dir: 1 | -1) => {
    const id = neighborId(
      filtered.map((c) => c.id),
      activeConversationId,
      dir
    );
    const next = id ? filtered.find((c) => c.id === id) : undefined;
    if (next && next.id !== activeConversationId) onSelect(next);
  };
  useInboxShortcuts({
    next: () => stepConversation(1),
    prev: () => stepConversation(-1),
    close: () => {
      if (activeConv && activeConv.status !== 'closed') {
        void handleRowStatusChange(activeConv.id, 'closed');
      }
    },
    reply: () => {
      document.querySelector<HTMLTextAreaElement>('[data-inbox-composer]')?.focus();
    },
    snooze: () => {
      if (activeConv && activeConv.status !== 'closed') setSnoozeDialogOpen(true);
    },
    help: () => setShortcutsHelpOpen(true),
  });

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="border-border bg-card flex h-full w-full flex-col border-r lg:w-80">
      {/* Search + Filter */}
      <div className="border-border space-y-2 border-b p-3">
        {/* The inbox as a to-do list — tap a queue, tap again to clear. */}
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              ['reply', CornerUpLeft],
              ['waiting', Hourglass],
              ['scheduled', CalendarClock],
            ] as const
          ).map(([key, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setQueue((q) => (q === key ? null : key))}
              aria-pressed={queue === key}
              className={cn(
                'flex min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors',
                queue === key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t(`queue.${key}`)}</span>
              {queueCounts[key] > 0 && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[10px] leading-4 tabular-nums',
                    queue === key
                      ? 'bg-primary-foreground/20'
                      : key === 'reply'
                        ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                        : 'bg-muted'
                  )}
                >
                  {queueCounts[key]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t('searchPlaceholder')}
            className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 pl-9 text-sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs">
              {activeFilter?.label ?? t('filterAll')}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    'text-sm',
                    filter === opt.value
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedTagIds.length > 0
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('tags')}
                {selectedTagIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-popover-foreground text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedCompany
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span className="truncate">
                  {selectedCompany ?? t('company')}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    'text-sm',
                    selectedCompany === null
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {t('allCompanies')}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      'text-sm',
                      selectedCompany === co
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {wahaChannels.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedChannel !== 'all'
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span className="truncate">
                  {selectedChannel === 'all'
                    ? t('channel')
                    : selectedChannel === 'cloud_api'
                      ? t('officialApi')
                      : (wahaChannelsById.get(selectedChannel)?.label ??
                        t('channel'))}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedChannel('all')}
                  className={cn(
                    'text-sm',
                    selectedChannel === 'all'
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {t('allChannels')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSelectedChannel('cloud_api')}
                  className={cn(
                    'text-sm',
                    selectedChannel === 'cloud_api'
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {t('officialApi')}
                </DropdownMenuItem>
                {wahaChannels.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onClick={() => setSelectedChannel(c.id)}
                    className={cn(
                      'text-sm',
                      selectedChannel === c.id
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    <span className="truncate">{c.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: tag?.color ?? 'var(--muted-foreground)',
                    }}
                  />
                  <span className="max-w-24 truncate">
                    {tag?.name ?? t('tags')}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-[11px]"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-muted-foreground text-sm">
              {t('noConversations')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                t={t}
                tThread={tThread}
                allTags={tags}
                profiles={profiles}
                routingPolicyMap={routingPolicyMap}
                onStatusChange={handleRowStatusChange}
                onAssignChange={handleRowAssignChange}
                onToggleTag={handleRowToggleTag}
                onSnooze={handleRowSnooze}
                onToggleConversationTag={handleRowToggleConversationTag}
                onClearHistory={handleRowClearHistory}
                now={nowTick}
                aiOn={aiOn}
                queue={queueById.get(conv.id) ?? null}
                appointment={
                  conv.contact_id ? (appointments.get(conv.contact_id) ?? null) : null
                }
                responseTimeTargetMinutes={responseTimeTargetMinutes}
                channelLabel={
                  wahaChannels.length === 0
                    ? null
                    : conv.whatsapp_channel_id
                      ? (wahaChannelsById.get(conv.whatsapp_channel_id)
                          ?.label ?? null)
                      : t('officialApi')
                }
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <Dialog open={snoozeDialogOpen} onOpenChange={setSnoozeDialogOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>{t('snooze')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {SNOOZE_PRESETS.map((preset) => (
              <Button
                key={preset}
                variant="outline"
                onClick={() => {
                  setSnoozeDialogOpen(false);
                  if (activeConv) {
                    void handleRowSnooze(
                      activeConv.id,
                      snoozePresetUntil(preset, new Date())
                    );
                  }
                }}
              >
                {t(`snoozePreset.${preset}`)}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={shortcutsHelpOpen} onOpenChange={setShortcutsHelpOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
            {SHORTCUT_ROWS.map(([keys, labelKey]) => (
              <div key={labelKey} className="contents">
                <dt className="flex gap-1">
                  {keys.map((k) => (
                    <kbd
                      key={k}
                      className="border-border bg-muted rounded border px-1.5 py-0.5 font-mono text-xs"
                    >
                      {k}
                    </kbd>
                  ))}
                </dt>
                <dd className="text-muted-foreground">
                  {t(`shortcuts.${labelKey}`)}
                </dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const SHORTCUT_ROWS: [string[], string][] = [
  [['j', '↓'], 'next'],
  [['k', '↑'], 'prev'],
  [['e'], 'close'],
  [['r'], 'reply'],
  [['s'], 'snooze'],
  [['?'], 'help'],
];

interface ConversationItemProps {
  /** Account-wide: is an AI auto-replying? undefined = not known yet. */
  aiOn?: boolean;
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  tThread: ReturnType<typeof useTranslations>;
  allTags: Tag[];
  profiles: Profile[];
  routingPolicyMap: Map<string, string[]>;
  onStatusChange: (
    conversationId: string,
    status: ConversationStatus
  ) => Promise<void>;
  onAssignChange: (
    conversationId: string,
    agentId: string | null
  ) => Promise<void>;
  onToggleTag: (
    contactId: string,
    currentTags: Tag[],
    tag: Tag
  ) => Promise<void>;
  onClearHistory: (conversationId: string) => Promise<void>;
  onSnooze: (conversationId: string, until: Date | null) => Promise<void>;
  onToggleConversationTag: (
    conversationId: string,
    currentTags: Tag[],
    tag: Tag
  ) => Promise<void>;
  /** Current time, ticked periodically by the parent (see the interval
   *  comment above) — passed in rather than read via `Date.now()` at
   *  render time so the badge advances even when nothing else about
   *  this row changes. */
  now: number;
  responseTimeTargetMinutes: number;
  /**
   * Which WhatsApp number this conversation is on — `null` when the
   * account has no WAHA channels configured (nothing to disambiguate,
   * so the badge stays hidden entirely rather than always saying
   * "Official API").
   */
  channelLabel: string | null;
  queue: WorkQueue | null;
  appointment: UpcomingAppointment | null;
}

const QUEUE_LINE: Record<WorkQueue, string> = {
  reply: 'bg-red-500/10 text-red-700 dark:text-red-400',
  waiting: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  scheduled: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
};

const SLA_TIER_CLASSES: Record<SlaTier, string> = {
  ok: 'bg-muted text-muted-foreground',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  breached: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
  tThread,
  allTags,
  profiles,
  routingPolicyMap,
  onStatusChange,
  onAssignChange,
  onToggleTag,
  onClearHistory,
  onSnooze,
  onToggleConversationTag,
  now,
  aiOn,
  responseTimeTargetMinutes,
  channelLabel,
  queue,
  appointment,
}: ConversationItemProps) {
  const conversationTags = conversation.tags ?? [];
  const snoozed = isSnoozed(conversation, now);
  const contact = conversation.contact;
  const eligibleAssigneeIds = eligibleAssigneesFromMap(
    routingPolicyMap,
    conversation.whatsapp_channel_id ?? null
  );
  const assignableProfiles = eligibleAssigneeIds
    ? profiles.filter((p) => eligibleAssigneeIds.includes(p.user_id))
    : profiles;
  const displayName = contact?.name || contact?.phone || t('unknown');
  const initials = initialsOf(displayName);
  const unread = conversation.unread_count > 0;
  // Who answers this thread, as a coloured dot on the avatar — the colour
  // follows who is in charge, not the status field (see commandOf).
  const command = commandOf({
    status: conversation.status,
    assignedAgentId: conversation.assigned_agent_id,
    aiAutoreplyDisabled: conversation.ai_autoreply_disabled,
    aiOn,
  });
  // 24h window: only worth a badge when it matters — about to close, or
  // closed (then only a template goes out).
  const win = windowState({
    isOfficialApi: !conversation.whatsapp_channel_id,
    lastCustomerMessageAt: (conversation as { last_customer_message_at?: string | null })
      .last_customer_message_at,
    now: new Date(now),
  });
  const windowBadge =
    conversation.status === 'closed'
      ? null
      : win.kind === 'closed'
        ? win.closedForMs === null
          ? t('window.never')
          : t('window.closed', { span: formatSpan(win.closedForMs) })
        : win.kind === 'open' && win.urgent
          ? t('window.closing', { span: formatSpan(win.remainingMs) })
          : null;
  const contactTags = contact?.tags ?? [];

  // Every context-menu mutation is fire-and-forget from the caller's
  // point of view (optimistic list already re-renders once the parent's
  // state patch lands), which on a slow connection reads as "did my
  // click even register?" — track which single menu item is in flight
  // so it can show a spinner instead of leaving the menu inert.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const canClearHistory = useCan('clear-conversation-history');

  const runPending = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setPendingKey(key);
      try {
        await action();
      } finally {
        setPendingKey(null);
      }
    },
    []
  );

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
        locale: dateFnsLocale,
      })
    : '';

  const sla = slaTier(conversation, now, responseTimeTargetMinutes);

  const row = (
    <button
      onClick={handleClick}
      className={cn(
        'hover:bg-muted/50 relative flex w-full items-start gap-3 px-3 py-3 text-left transition-colors',
        isActive && 'bg-muted/70'
      )}
      aria-current={isActive ? 'true' : undefined}
    >
      {isActive && (
        <span className="bg-primary absolute inset-y-0 left-0 w-0.5" aria-hidden />
      )}
      {/* Avatar — the photo when we have one (WAHA numbers), initials
          otherwise; the dot says who is answering. */}
      <div className="relative shrink-0">
        <div className="bg-muted text-muted-foreground flex h-10 w-10 items-center justify-center overflow-hidden rounded-full text-xs font-semibold">
          {contact?.avatar_url ? (
            <img
              src={contact.avatar_url}
              alt=""
              className="h-10 w-10 rounded-full object-cover"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            initials
          )}
        </div>
        <span
          className={cn(
            'border-background absolute -bottom-0.5 -left-0.5 h-3 w-3 rounded-full border-2',
            COMMAND_DOT[command]
          )}
          title={t(`command.${command}`)}
          aria-label={t(`command.${command}`)}
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'text-foreground truncate text-sm',
                unread ? 'font-semibold' : 'font-medium'
              )}
            >
              {displayName}
            </span>
            {channelLabel && (
              <span
                title={channelLabel}
                className="bg-muted text-muted-foreground shrink-0 truncate rounded-full px-1.5 py-0.5 text-[9px] leading-none font-medium"
              >
                {channelLabel}
              </span>
            )}
          </span>
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p
            className={cn(
              'truncate text-xs',
              unread ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {conversation.last_message_sender_type === 'bot' && (
              <Bot
                className="mr-1 inline h-3 w-3 align-[-2px]"
                aria-label={t('lastByBot')}
              />
            )}
            {conversation.last_message_text || t('noMessagesYet')}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {sla && (
              <span
                className={cn(
                  'flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium',
                  SLA_TIER_CLASSES[sla.tier]
                )}
                title={t('slaWaitingTitle', {
                  minutes: responseTimeTargetMinutes,
                })}
              >
                <Clock className="h-2.5 w-2.5" />
                {formatElapsedMinutes(sla.elapsedMinutes)}
              </span>
            )}
            {conversation.unread_count > 0 && (
              <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                {conversation.unread_count}
              </span>
            )}
          </div>
        </div>
        {((contact?.tags && contact.tags.length > 0) ||
          contact?.dealStage ||
          conversationTags.length > 0 ||
          snoozed ||
          windowBadge) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {windowBadge && (
              <span
                className={cn(
                  'rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium',
                  win.kind === 'closed'
                    ? 'border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300'
                    : 'border-red-400 text-red-700 dark:border-red-700 dark:text-red-300'
                )}
                title={t('window.title')}
              >
                {windowBadge}
              </span>
            )}
            {snoozed && conversation.snoozed_until && (
              <span
                className="flex items-center gap-0.5 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] leading-none font-medium text-sky-700 dark:text-sky-400"
                title={t('snoozedUntilTitle', {
                  time: new Date(conversation.snoozed_until).toLocaleString(),
                })}
              >
                <AlarmClock className="h-2.5 w-2.5" />
                {t('snoozedBadge')}
              </span>
            )}
            {/* Conversation tags get a # prefix and an outlined style so
                they read as "this thread" vs. the filled contact tags. */}
            {conversationTags.map((tag) => (
              <span
                key={`conv-${tag.id}`}
                title={t('conversationTagTitle', { name: tag.name })}
                className="inline-flex max-w-[100px] items-center gap-0.5 truncate rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium"
                style={{ borderColor: tag.color, color: tag.color }}
              >
                <Hash className="h-2.5 w-2.5 shrink-0" />
                {tag.name}
              </span>
            ))}
            {contact?.dealStage && (
              <span
                title={contact.dealStage.name}
                className="inline-block max-w-[110px] truncate rounded-full px-1.5 py-0.5 text-[10px] leading-none font-semibold uppercase"
                style={{
                  backgroundColor: `${contact.dealStage.color}20`,
                  color: contact.dealStage.color,
                }}
              >
                {contact.dealStage.name}
              </span>
            )}
            {contact?.tags?.map((tag) => (
              <span
                key={tag.id}
                title={tag.name}
                className="inline-block max-w-[90px] truncate rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
        {queue && (
          <div
            className={cn(
              'mt-1.5 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium',
              QUEUE_LINE[queue]
            )}
          >
            {queue === 'reply' ? (
              <CornerUpLeft className="h-3 w-3 shrink-0" />
            ) : queue === 'waiting' ? (
              <Hourglass className="h-3 w-3 shrink-0" />
            ) : (
              <CalendarClock className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate">
              {queue === 'scheduled' && appointment
                ? appointment.title
                : t(`queueLine.${queue}`)}
            </span>
            {queue === 'scheduled' && appointment && (
              <span className="ml-auto shrink-0 opacity-80">
                {isToday(new Date(appointment.starts_at))
                  ? t('queueWhen.today', { time: format(new Date(appointment.starts_at), 'HH:mm') })
                  : isTomorrow(new Date(appointment.starts_at))
                    ? t('queueWhen.tomorrow', { time: format(new Date(appointment.starts_at), 'HH:mm') })
                    : format(new Date(appointment.starts_at), 'dd/MM HH:mm')}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuLabel>{tThread('status')}</ContextMenuLabel>
          {(Object.keys(STATUS_LABEL_KEY) as ConversationStatus[]).map(
            (status) => {
              const key = `status:${status}`;
              const busy = pendingKey === key;
              return (
                <ContextMenuItem
                  key={status}
                  disabled={pendingKey !== null}
                  closeOnClick={false}
                  onClick={() =>
                    runPending(key, () =>
                      onStatusChange(conversation.id, status)
                    )
                  }
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    conversation.status === status && (
                      <Check className="h-3.5 w-3.5" />
                    )
                  )}
                  {tThread(STATUS_LABEL_KEY[status])}
                </ContextMenuItem>
              );
            }
          )}
        </ContextMenuGroup>

        {/* Snooze only makes sense for a thread still in the active
            queue — a closed one has nothing to "wake up" into. */}
        {(conversation.status !== 'closed' || snoozed) && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuLabel>{t('snooze')}</ContextMenuLabel>
              {snoozed ? (
                <ContextMenuItem
                  disabled={pendingKey !== null}
                  closeOnClick={false}
                  onClick={() =>
                    runPending('snooze:clear', () =>
                      onSnooze(conversation.id, null)
                    )
                  }
                >
                  {pendingKey === 'snooze:clear' && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {t('unsnooze')}
                </ContextMenuItem>
              ) : (
                SNOOZE_PRESETS.map((preset) => {
                  const key = `snooze:${preset}`;
                  return (
                    <ContextMenuItem
                      key={preset}
                      disabled={pendingKey !== null}
                      closeOnClick={false}
                      onClick={() =>
                        runPending(key, () =>
                          onSnooze(
                            conversation.id,
                            snoozePresetUntil(preset, new Date())
                          )
                        )
                      }
                    >
                      {pendingKey === key && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      {t(`snoozePreset.${preset}`)}
                    </ContextMenuItem>
                  );
                })
              )}
            </ContextMenuGroup>
          </>
        )}

        <ContextMenuSeparator />

        <ContextMenuGroup>
          <ContextMenuLabel>{tThread('assign')}</ContextMenuLabel>
          {assignableProfiles.length === 0 ? (
            <ContextMenuItem disabled>
              {eligibleAssigneeIds
                ? tThread('noResponsibles')
                : tThread('noTeammates')}
            </ContextMenuItem>
          ) : (
            assignableProfiles.map((p) => {
              const key = `assign:${p.user_id}`;
              const busy = pendingKey === key;
              return (
                <ContextMenuItem
                  key={p.id}
                  disabled={pendingKey !== null}
                  closeOnClick={false}
                  onClick={() =>
                    runPending(key, () =>
                      onAssignChange(conversation.id, p.user_id)
                    )
                  }
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    conversation.assigned_agent_id === p.user_id && (
                      <Check className="h-3.5 w-3.5" />
                    )
                  )}
                  {p.full_name}
                </ContextMenuItem>
              );
            })
          )}
          {conversation.assigned_agent_id && (
            <ContextMenuItem
              disabled={pendingKey !== null}
              closeOnClick={false}
              onClick={() =>
                runPending('assign:null', () =>
                  onAssignChange(conversation.id, null)
                )
              }
            >
              {pendingKey === 'assign:null' && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              {tThread('unassign')}
            </ContextMenuItem>
          )}
        </ContextMenuGroup>

        {contact && allTags.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuLabel>{t('tags')}</ContextMenuLabel>
              {allTags.map((tag) => {
                const checked = contactTags.some((ct) => ct.id === tag.id);
                const key = `tag:${tag.id}`;
                const busy = pendingKey === key;
                return (
                  <ContextMenuItem
                    key={tag.id}
                    disabled={pendingKey !== null}
                    closeOnClick={false}
                    onClick={() =>
                      runPending(key, () =>
                        onToggleTag(contact.id, contactTags, tag)
                      )
                    }
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      checked && <Check className="h-3.5 w-3.5" />
                    )}
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="truncate">{tag.name}</span>
                  </ContextMenuItem>
                );
              })}
            </ContextMenuGroup>
          </>
        )}

        {allTags.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuLabel>{t('conversationTags')}</ContextMenuLabel>
              {allTags.map((tag) => {
                const checked = conversationTags.some((ct) => ct.id === tag.id);
                const key = `ctag:${tag.id}`;
                const busy = pendingKey === key;
                return (
                  <ContextMenuItem
                    key={tag.id}
                    disabled={pendingKey !== null}
                    closeOnClick={false}
                    onClick={() =>
                      runPending(key, () =>
                        onToggleConversationTag(
                          conversation.id,
                          conversationTags,
                          tag
                        )
                      )
                    }
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      checked && <Check className="h-3.5 w-3.5" />
                    )}
                    <Hash
                      className="h-3 w-3 shrink-0"
                      style={{ color: tag.color }}
                    />
                    <span className="truncate">{tag.name}</span>
                  </ContextMenuItem>
                );
              })}
            </ContextMenuGroup>
          </>
        )}

        {canClearHistory && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem
                disabled={pendingKey !== null}
                closeOnClick={false}
                variant="destructive"
                onClick={() => {
                  if (!window.confirm(t('clearHistoryConfirm'))) return;
                  runPending('clear-history', () =>
                    onClearHistory(conversation.id)
                  );
                }}
              >
                {pendingKey === 'clear-history' && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                {t('clearHistory')}
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
