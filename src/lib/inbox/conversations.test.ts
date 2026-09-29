import { describe, it, expect } from "vitest";
import {
  isSnoozed,
  matchesContactFilters,
  normalizeConversation,
  snoozePresetUntil,
} from "./conversations";
import type { Conversation } from "@/types";

function makeConversation(
  contact: Partial<Conversation["contact"]> | null,
): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "open",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    contact: contact
      ? {
          id: "ct1",
          user_id: "u1",
          account_id: "a1",
          phone: "123",
          created_at: "",
          updated_at: "",
          ...contact,
        }
      : undefined,
  };
}

const tag = (id: string, name = id) => ({
  id,
  user_id: "u1",
  name,
  color: "#fff",
  created_at: "",
});

describe("matchesContactFilters", () => {
  it("matches everything when no filters are set", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(matchesContactFilters(conv, { tagIds: [], company: null })).toBe(
      true,
    );
    expect(makeConversation(null)).toBeDefined();
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
      }),
    ).toBe(true);
  });

  it("uses OR logic across tags", () => {
    const conv = makeConversation({ tags: [tag("t1"), tag("t2")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t2", "t9"], company: null }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t9"], company: null }),
    ).toBe(false);
  });

  it("excludes conversations whose contact has no tags when a tag filter is active", () => {
    const conv = makeConversation({ tags: [] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: null }),
    ).toBe(false);
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: ["t1"],
        company: null,
      }),
    ).toBe(false);
  });

  it("matches company exactly, trimming whitespace", () => {
    const conv = makeConversation({ company: "  Acme  " });
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Other" }),
    ).toBe(false);
  });

  it("requires both tag and company to match when both are set (AND across facets)", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Other" }),
    ).toBe(false);
    expect(
      matchesContactFilters(conv, { tagIds: ["tX"], company: "Acme" }),
    ).toBe(false);
  });
});

describe("normalizeConversation", () => {
  it("flattens embedded contact_tags into contact.tags", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        contact_tags: [{ tags: tag("t1", "VIP") }, { tags: null }],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.tags).toEqual([tag("t1", "VIP")]);
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).contact_tags,
    ).toBeUndefined();
  });

  it("passes through a conversation with no contact", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    // A contactless row passes through untouched (consumers use `?.`).
    expect(normalizeConversation(raw).contact).toBeNull();
  });
});

describe("conversation-level tags (migration 070)", () => {
  it("flattens conversation_tags onto conversation.tags, separate from contact tags", () => {
    const raw = {
      ...makeConversation(null),
      conversation_tags: [{ tags: tag("t-conv") }, { tags: null }],
    } as unknown as Parameters<typeof normalizeConversation>[0];
    const conv = normalizeConversation(raw);
    expect(conv.tags?.map((t) => t.id)).toEqual(["t-conv"]);
    expect(conv).not.toHaveProperty("conversation_tags");
  });

  it("tag filter matches a tag sitting only on the conversation", () => {
    const conv = { ...makeConversation({ tags: [] }), tags: [tag("t1")] };
    expect(matchesContactFilters(conv, { tagIds: ["t1"], company: null })).toBe(true);
    expect(matchesContactFilters(conv, { tagIds: ["t2"], company: null })).toBe(false);
  });
});

describe("isSnoozed", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  it("is false with no snoozed_until", () => {
    expect(isSnoozed(makeConversation(null), now)).toBe(false);
  });
  it("is true while the snooze is in the future", () => {
    const conv = { ...makeConversation(null), snoozed_until: "2026-09-29T13:00:00Z" };
    expect(isSnoozed(conv, now)).toBe(true);
  });
  it("is false once the snooze has passed — the conversation reappears on its own", () => {
    const conv = { ...makeConversation(null), snoozed_until: "2026-09-29T11:59:00Z" };
    expect(isSnoozed(conv, now)).toBe(false);
  });
});

describe("snoozePresetUntil", () => {
  const now = new Date(2026, 8, 29, 22, 30); // local time
  it("adds 1h / 3h", () => {
    expect(snoozePresetUntil("1h", now).getTime() - now.getTime()).toBe(3_600_000);
    expect(snoozePresetUntil("3h", now).getTime() - now.getTime()).toBe(10_800_000);
  });
  it("tomorrow is 09:00 local on the next day", () => {
    const d = snoozePresetUntil("tomorrow", now);
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([30, 9, 0]);
  });
});
