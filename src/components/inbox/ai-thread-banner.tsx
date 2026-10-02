"use client";

import { useState, useEffect, useCallback } from "react";
import { Sparkles, Hand, Undo2, Loader2, Check, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import type { Conversation } from "@/types";

// ------------------------------------------------------------
// Account AI status is the same for every conversation, so cache it per
// account and reuse it across thread switches instead of hitting
// /api/ai/config every time the agent opens a chat.
//
// Keyed by accountId (a multi-account user switching workspaces must not
// see the previous account's status), and only *successful* fetches are
// cached — a transient failure returns a default without poisoning the
// cache, so it retries on the next thread open rather than hiding the
// banner for the whole session.
// ------------------------------------------------------------
interface AiAccountStatus {
  autoReplyOn: boolean;
}
const statusCache = new Map<string, AiAccountStatus>();

async function fetchAiAccountStatus(accountId: string): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached) return cached;
  try {
    // Any agent counts, not just the default: with the default switched
    // off and another agent bound to the number, the AI still answers —
    // and the banner (with its "Assumir" button) must still show.
    const { data, error } = await createClient()
      .from("ai_configs")
      .select("id")
      .eq("account_id", accountId)
      .eq("is_active", true)
      .eq("auto_reply_enabled", true)
      .limit(1);
    if (error) return { autoReplyOn: false }; // don't cache a transient failure
    const status = { autoReplyOn: (data ?? []).length > 0 };
    statusCache.set(accountId, status);
    return status;
  } catch {
    return { autoReplyOn: false }; // don't cache
  }
}

interface AiThreadBannerProps {
  conversationId: string;
  /** `conversations.ai_autoreply_disabled` — bot paused on this thread. */
  disabled: boolean;
  /** `conversations.ai_handoff_summary` — legacy English note, only on
   *  rows written before migration 072. */
  handoffSummary?: string | null;
  /** Why the bot stopped, and the facts behind it (migration 072). */
  handoffReason?: string | null;
  handoffMeta?: Conversation["ai_handoff_meta"];
  /** Whether the customer was told a person is taking over. */
  customerNotified?: boolean | null;
  noticeSkippedReason?: string | null;
  /** Current assignee; when a human owns the thread the bot won't run,
   *  so the "AI active" banner is suppressed. */
  assignedAgentId?: string | null;
  /** The acting agent — "Take over" assigns the thread to them. */
  currentUserId?: string | null;
  /** Called after a successful toggle so the parent can patch its local
   *  conversation state (the realtime UPDATE also arrives, but this keeps
   *  the banner instant). */
  onChange?: (patch: {
    ai_autoreply_disabled: boolean;
    assigned_agent_id?: string | null;
  }) => void;
}

/**
 * Inbox banner that surfaces + controls the AI auto-reply bot per
 * conversation:
 *   - bot active here → "AI is replying automatically" + [Take over]
 *   - bot paused here → the handoff note (if any) + [Resume AI]
 *   - bot on, but a human is assigned (e.g. a transfer) → the bot stays
 *     silent, so say so + [Resume AI], which also releases the assignee
 * Renders nothing when the account has no auto-reply configured.
 */
export function AiThreadBanner({
  conversationId,
  disabled,
  handoffSummary,
  handoffReason,
  handoffMeta,
  customerNotified,
  noticeSkippedReason,
  assignedAgentId,
  currentUserId,
  onChange,
}: AiThreadBannerProps) {
  const t = useTranslations("Inbox.aiBanner");
  const { accountId } = useAuth();
  const [autoReplyOn, setAutoReplyOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // Optimistic local mirror of the pause flag so the banner flips
  // instantly on click; re-seeds whenever the thread (or its server
  // state via realtime) changes.
  const [paused, setPaused] = useState(disabled);
  useEffect(() => setPaused(disabled), [conversationId, disabled]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchAiAccountStatus(accountId).then((s) => alive && setAutoReplyOn(s.autoReplyOn));
    return () => {
      alive = false;
    };
  }, [accountId]);

  const toggle = useCallback(
    async (paused: boolean) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // "Take over" also assigns the thread to the acting agent.
          body: JSON.stringify({ paused, assign_to_me: paused }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j?.error ?? t("updateError"));
          return;
        }
        setPaused(paused);
        onChange?.({
          ai_autoreply_disabled: paused,
          // Take over assigns to the acting agent; resume releases only
          // the caller's own assignment. The realtime UPDATE reconciles
          // the exact value either way.
          ...(paused
            ? currentUserId
              ? { assigned_agent_id: currentUserId }
              : {}
            : { assigned_agent_id: null }),
        });
        toast.success(paused ? t("tookOver") : t("resumed"));
      } catch {
        toast.error(t("networkError"));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, currentUserId, onChange, t],
  );

  // Account has no auto-reply → nothing to show. (Still loading → nothing.)
  if (!autoReplyOn) return null;

  // Paused here (a human took over, or the model handed off).
  if (paused) {
    return (
      <Banner tone="muted" align="start">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-medium text-foreground">{t("pausedTitle")}</p>
          {handoffReason ? (
            <HandoffDetails
              reason={handoffReason}
              meta={handoffMeta ?? null}
              customerNotified={customerNotified ?? null}
              noticeSkippedReason={noticeSkippedReason ?? null}
            />
          ) : (
            handoffSummary && <ClampedText text={handoffSummary} />
          )}
        </div>
        <BannerButton onClick={() => toggle(false)} busy={busy} icon={Undo2}>
          {t("resume")}
        </BannerButton>
      </Banner>
    );
  }

  // Not paused, but a human owns it → auto-reply skips assigned threads.
  // Without this the only way back to the bot was unassigning by hand.
  if (assignedAgentId) {
    return (
      <Banner tone="muted">
        <p className="min-w-0 flex-1 truncate font-medium text-foreground">
          {t("assignedTitle")}
        </p>
        <BannerButton onClick={() => toggle(false)} busy={busy} icon={Undo2}>
          {t("resume")}
        </BannerButton>
      </Banner>
    );
  }

  // Active on this thread.
  return (
    <Banner tone="primary">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
        <span className="truncate font-medium text-foreground">
          {t("activeText")}
        </span>
      </div>
      <BannerButton onClick={() => toggle(true)} busy={busy} icon={Hand}>
        {t("takeOver")}
      </BannerButton>
    </Banner>
  );
}

// snake_case reason codes (CHECK in migration 072) → message keys.
const REASON_KEYS: Record<string, string> = {
  model_requested: "modelRequested",
  reply_cap: "replyCap",
  provider_failure: "providerFailure",
  empty_reply: "emptyReply",
  rate_limited: "rateLimited",
  system_error: "systemError",
  customer_requested_human: "customerRequestedHuman",
  audio_unintelligible: "audioUnintelligible",
  case_escalated: "caseEscalated",
};

const ATTEMPT_CODES = new Set([
  "rate_limited",
  "timeout",
  "invalid_key",
  "network_error",
  "unavailable",
]);

/** Why the bot stopped, the customer's last message, and whether the
 *  customer was told — the three things a human opening a handed-off
 *  thread needs, in the deployment's language. */
function HandoffDetails({
  reason,
  meta,
  customerNotified,
  noticeSkippedReason,
}: {
  reason: string;
  meta: Conversation["ai_handoff_meta"] | null;
  customerNotified: boolean | null;
  noticeSkippedReason: string | null;
}) {
  const t = useTranslations("Inbox.aiBanner.handoff");
  const reasonKey = REASON_KEYS[reason];
  const attempts = (meta?.attempts ?? [])
    .map(
      (a) =>
        `${a.provider} (${t(`attemptCode.${ATTEMPT_CODES.has(a.code) ? a.code : "unavailable"}`)})`,
    )
    .join(", ");
  // Unknown skip reasons (a newer server than this client) fall back to
  // the generic "failed to send" wording rather than a raw key.
  const skippedKey =
    noticeSkippedReason &&
    ["send_failed", "opted_out", "human_assigned", "no_notice_text"].includes(
      noticeSkippedReason,
    )
      ? noticeSkippedReason
      : "send_failed";

  return (
    <div className="space-y-1.5 text-muted-foreground">
      {reasonKey && <p>{t(`reason.${reasonKey}`, { max: meta?.max ?? 0 })}</p>}
      {attempts && <p>{t("attempts", { list: attempts })}</p>}
      {meta?.lastCustomerMessage && (
        <div className="border-l-2 border-border pl-2">
          <p className="text-[11px] font-medium uppercase tracking-wide">
            {t("lastMessage")}
          </p>
          <ClampedText text={meta.lastCustomerMessage} />
        </div>
      )}
      {customerNotified === true && (
        <p className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
          <Check className="h-3 w-3" />
          {t("notified")}
        </p>
      )}
      {customerNotified === false && (
        <p className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
          <TriangleAlert className="h-3 w-3" />
          {t("notNotified", { reason: t(`skipped.${skippedKey}`) })}
        </p>
      )}
    </div>
  );
}

/** Wrapped text, three lines then "show more" — the handoff note used to
 *  be a one-line ellipsis whose full text lived in a hover tooltip, which
 *  does nothing on a phone. */
function ClampedText({ text }: { text: string }) {
  const t = useTranslations("Inbox.aiBanner.handoff");
  const [open, setOpen] = useState(false);
  const long = text.length > 140;
  return (
    <div>
      <p
        className={cn(
          "whitespace-pre-line break-words text-muted-foreground",
          !open && "line-clamp-3",
        )}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 font-medium text-foreground underline-offset-2 hover:underline"
        >
          {open ? t("showLess") : t("showMore")}
        </button>
      )}
    </div>
  );
}

function Banner({
  tone,
  align = "center",
  children,
}: {
  tone: "primary" | "muted";
  align?: "center" | "start";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex gap-3 border-b px-3 py-2 text-xs sm:px-4",
        align === "start" ? "items-start" : "items-center",
        tone === "primary"
          ? "border-primary/20 bg-primary/5"
          : "border-border bg-muted/40",
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: typeof Hand;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {children}
    </button>
  );
}
