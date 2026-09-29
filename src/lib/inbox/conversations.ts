import type { Conversation, Contact, Tag, Deal, PipelineStage } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags and open deals,
 * so the Inbox can filter by tag and show the contact's pipeline stage
 * without a second round-trip. `contact_tags(tags(*))` returns the tag join
 * rows; `deals(...)` returns the contact's deals with their stage embedded.
 * {@link normalizeConversation} flattens both onto `contact`.
 */
export const CONVERSATION_SELECT =
  "*, conversation_tags(tags(*)), contact:contacts(*, contact_tags(tags(*)), deals(id, status, updated_at, stage:pipeline_stages(*)))";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawDeal = Pick<Deal, "id" | "status" | "updated_at"> & {
  stage: PipelineStage | null;
};
type RawContact = Contact & {
  contact_tags?: { tags: Tag | null }[];
  deals?: RawDeal[];
};
type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
  conversation_tags?: { tags: Tag | null }[];
};

function flattenTags(rows: { tags: Tag | null }[] | undefined): Tag[] {
  return (rows ?? []).map((r) => r.tags).filter((t): t is Tag => t != null);
}

/**
 * Pick the stage to display for a contact: the most recently updated open
 * deal, so a contact with several deals shows where the live one stands
 * rather than an arbitrary or stale closed one.
 */
function pickDealStage(deals: RawDeal[]): PipelineStage | undefined {
  const openDeals = deals.filter((d) => d.status === "open" && d.stage);
  if (openDeals.length === 0) return undefined;
  openDeals.sort(
    (a, b) =>
      new Date(b.updated_at ?? 0).getTime() -
      new Date(a.updated_at ?? 0).getTime(),
  );
  return openDeals[0].stage ?? undefined;
}

/**
 * Flatten the embedded `contact_tags(tags(*))` and `deals(...)` joins onto
 * `contact.tags` / `contact.dealStage`. Safe to call on rows fetched with
 * {@link CONVERSATION_SELECT}; a row with no contact (e.g. a freshly-inserted
 * conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const { conversation_tags, ...rest } = raw;
  // Only overwrite `tags` when the embed was actually selected — a row
  // from a narrower select (or a realtime payload) keeps what it had.
  const base =
    conversation_tags !== undefined
      ? { ...rest, tags: flattenTags(conversation_tags) }
      : rest;

  const rawContact = base.contact;
  if (!rawContact) return base as Conversation;

  const { contact_tags, deals, ...contact } = rawContact;
  return {
    ...base,
    contact: {
      ...contact,
      tags: flattenTags(contact_tags),
      dealStage: pickDealStage(deals ?? []),
    },
  };
}

/**
 * Whether a conversation is currently snoozed (migration 070). An
 * expired snooze reads as not-snoozed, which is the whole "reappears
 * on its own, no cron" mechanism: the inbox re-evaluates this on its
 * periodic tick.
 */
export function isSnoozed(conversation: Conversation, now: number): boolean {
  if (!conversation.snoozed_until) return false;
  const until = new Date(conversation.snoozed_until).getTime();
  return Number.isFinite(until) && until > now;
}

export type SnoozePreset = "1h" | "3h" | "tomorrow";

/** Resolve a snooze preset to an absolute time. "tomorrow" = 09:00 local. */
export function snoozePresetUntil(preset: SnoozePreset, now: Date): Date {
  if (preset === "1h") return new Date(now.getTime() + 60 * 60_000);
  if (preset === "3h") return new Date(now.getTime() + 3 * 60 * 60_000);
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    // A tag filter matches whether the tag sits on the contact or on
    // this specific thread — one vocabulary, either attachment point.
    const anyTags = [
      ...(conversation.contact?.tags ?? []),
      ...(conversation.tags ?? []),
    ];
    if (!anyTags.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}
