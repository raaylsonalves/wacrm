'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { slaTier, formatElapsedMinutes, type SlaTier } from '@/lib/inbox/sla';
import type { Conversation, ConversationStatus, Profile, Tag } from '@/types';
import { Search, ChevronDown, X, Check, Loader2, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
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
}

const STATUS_LABEL_KEY: Record<ConversationStatus, string> = {
  open: 'statusOpen',
  pending: 'statusPending',
  closed: 'statusClosed',
};

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: 'bg-primary',
  pending: 'bg-amber-500',
  closed: 'bg-muted-foreground',
};

type InboxFilter = ConversationStatus | 'all' | 'unread';

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
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');
  const tThread = useTranslations('Inbox.messageThread');
  const { responseTimeTargetMinutes } = useAuth();

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
      { label: t('filterOpen'), value: 'open' },
      { label: t('filterPending'), value: 'pending' },
      { label: t('filterClosed'), value: 'closed' },
    ],
    [t]
  );

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');
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

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === 'unread') {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== 'all') {
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
    search,
    selectedTagIds,
    selectedCompany,
    selectedChannel,
  ]);

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
                onStatusChange={handleRowStatusChange}
                onAssignChange={handleRowAssignChange}
                onToggleTag={handleRowToggleTag}
                now={nowTick}
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
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  tThread: ReturnType<typeof useTranslations>;
  allTags: Tag[];
  profiles: Profile[];
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
}

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
  onStatusChange,
  onAssignChange,
  onToggleTag,
  now,
  responseTimeTargetMinutes,
  channelLabel,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t('unknown');
  const initials = displayName.charAt(0).toUpperCase();
  const contactTags = contact?.tags ?? [];

  // Every context-menu mutation is fire-and-forget from the caller's
  // point of view (optimistic list already re-renders once the parent's
  // state patch lands), which on a slow connection reads as "did my
  // click even register?" — track which single menu item is in flight
  // so it can show a spinner instead of leaving the menu inert.
  const [pendingKey, setPendingKey] = useState<string | null>(null);

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
        'hover:bg-muted/50 flex w-full items-start gap-3 px-3 py-3 text-left transition-colors',
        isActive && 'border-primary bg-muted/70 border-l-2'
      )}
    >
      {/* Avatar */}
      <div className="bg-muted text-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-foreground truncate text-sm font-medium">
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
          <p className="text-muted-foreground truncate text-xs">
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
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
        {((contact?.tags && contact.tags.length > 0) || contact?.dealStage) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
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

        <ContextMenuSeparator />

        <ContextMenuGroup>
          <ContextMenuLabel>{tThread('assign')}</ContextMenuLabel>
          {profiles.length === 0 ? (
            <ContextMenuItem disabled>{tThread('noTeammates')}</ContextMenuItem>
          ) : (
            profiles.map((p) => {
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
      </ContextMenuContent>
    </ContextMenu>
  );
}
