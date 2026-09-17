import type { Conversation, Contact, Tag, Deal, PipelineStage } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags and open deals,
 * so the Inbox can filter by tag and show the contact's pipeline stage
 * without a second round-trip. `contact_tags(tags(*))` returns the tag join
 * rows; `deals(...)` returns the contact's deals with their stage embedded.
 * {@link normalizeConversation} flattens both onto `contact`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*)), deals(id, status, updated_at, stage:pipeline_stages(*)))";

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
};

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
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, deals, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
      dealStage: pickDealStage(deals ?? []),
    },
  };
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
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}
