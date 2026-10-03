"use client";

import { cn } from "@/lib/utils";
import { createContext, useContext } from "react";
import type { Message, MessageReaction, MessageTemplate } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  MapPin,
  LayoutTemplate,
  CornerDownLeft,
  Sparkles,
  ExternalLink,
  Phone,
  Copy,
  Image as ImageIcon,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import {
  MediaAudioBubble,
  MediaDocumentBubble,
  MediaImageBubble,
  MediaUnavailable,
  MediaVideoBubble,
} from "./message-media";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { useTranslations } from "next-intl";
import { parseWhatsAppFormat } from "@/lib/inbox/wa-format";

/** The parts of a template a sent message doesn't store (header, footer,
 *  buttons), by template name. The thread loads the account's templates
 *  once and provides them; without a provider the bubble shows the body. */
export type TemplateShape = Pick<
  MessageTemplate,
  "header_type" | "header_content" | "footer_text" | "buttons"
>;
export const TemplateLookupContext = createContext<Map<string, TemplateShape>>(new Map());

/** Message text with WhatsApp's *bold* / _italic_ / ~strike~ / ```mono```. */
function WaText({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <>
      {parseWhatsAppFormat(text).map((seg, i) => (
        <span
          key={i}
          className={cn(
            seg.bold && "font-semibold",
            seg.italic && "italic",
            seg.strike && "line-through",
            seg.mono && "rounded bg-black/10 px-1 font-mono text-[0.9em] dark:bg-white/10",
          )}
        >
          {seg.text}
        </span>
      ))}
    </>
  );
}

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /**
   * Opens the thread's media viewer on this message. Only images and videos
   * call it; omitted when the parent renders no viewer, in which case media
   * stays inline and non-clickable.
   */
  onOpenMedia?: (messageId: string) => void;
  /** First bubble of a run from one side — draws the WhatsApp tail. */
  tail?: boolean;
}

/** The little hook on the first bubble of a run, in the bubble's colour. */
function BubbleTail({ out }: { out: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 13"
      width="8"
      height="13"
      className={cn(
        "absolute top-0",
        out ? "-right-2 text-primary" : "-left-2 -scale-x-100 text-card",
      )}
    >
      <path fill="currentColor" d="M0 0h8L1.5 8.5C1 9.2 0 8.9 0 8V0z" />
    </svg>
  );
}

/**
 * "[title] — [details]" for a failed message, or null when the row
 * predates migration 042 / Meta sent no reason. Shared by the status
 * icon's tooltip and the line under the bubble.
 */
function failureReason(message: Message): string | null {
  if (message.status !== "failed" || !message.error_title) return null;
  return message.error_details
    ? `${message.error_title} — ${message.error_details}`
    : message.error_title;
}

function StatusIcon({
  status,
  title,
}: {
  status: Message["status"];
  /** Tooltip for the failed state — Meta's reason, when we have one. */
  title?: string | null;
}) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-600 dark:text-blue-400" />;
    case "failed":
      return (
        <span className="inline-flex" title={title ?? undefined}>
          <XCircle className="h-3 w-3 text-red-600 dark:text-red-400" />
        </span>
      );
    default:
      return null;
  }
}

/**
 * The words behind a voice note: the customer's transcript (written when
 * the AI transcribed it), or, on the AI's own voice reply, the text it
 * spoke (kept in content_text). A person skims this faster than they can
 * play the audio.
 */
function AudioText({
  message,
  t,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
}) {
  const fromCustomer = message.sender_type === "customer";
  const text = fromCustomer ? message.transcript : message.content_text;
  if (text && text.trim()) {
    return (
      <p className="mt-1 max-w-[280px] whitespace-pre-wrap break-words text-xs opacity-80">
        <span className="font-medium">{t("transcript")}:</span>{" "}
        <span className="italic"><WaText text={text} /></span>
      </p>
    );
  }
  if (fromCustomer && message.transcript_status === "failed") {
    return <p className="mt-1 text-xs italic opacity-70">{t("transcriptFailed")}</p>;
  }
  return null;
}

function MessageContent({
  message,
  t,
  isAgent,
  onOpenMedia,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  /** Outbound bubbles sit on the primary fill — badges must invert. */
  isAgent: boolean;
  onOpenMedia?: (messageId: string) => void;
}) {
  // Passed to the media bubbles as a no-arg callback; `undefined` when the
  // parent wired up no viewer, which is what makes them non-clickable.
  const openMedia = onOpenMedia ? () => onOpenMedia(message.id) : undefined;

  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          <WaText text={message.content_text} />
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImageBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              <WaText text={message.content_text} />
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <MediaVideoBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              <WaText text={message.content_text} />
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <MediaAudioBubble message={message} t={t} />
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
          <AudioText message={message} t={t} />
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      return <MediaDocumentBubble message={message} t={t} />;

    case "template":
      return <TemplateBubble message={message} isAgent={isAgent} t={t} />;

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || t("locationShared")}</span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || t("interactiveReply")}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("interactiveReply")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          <WaText text={message.content_text || t("unsupported")} />
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenMedia,
  tail = true,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");
  const failure = isAgent ? failureReason(message) : null;

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-lg px-2.5 pt-1.5 pb-1 shadow-sm",
          isAgent
            ? "bg-primary text-primary-foreground"
            : "bg-card text-card-foreground",
          tail && (isAgent ? "rounded-tr-none" : "rounded-tl-none"),
        )}
      >
        {tail && <BubbleTail out={isAgent} />}
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent
          message={message}
          t={t}
          isAgent={isAgent}
          onOpenMedia={onOpenMedia}
        />
        <div
          className={cn(
            "-mt-0.5 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-primary-foreground"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} title={failure} />}
        </div>
      </div>
      {failure && (
        <p
          className="mt-0.5 px-1 text-[10px] leading-tight text-muted-foreground"
          title={failure}
        >
          {t("notDelivered")}: {failure}
        </p>
      )}
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}

/**
 * A sent template as the customer saw it: header, the stored (already
 * substituted) body, footer and buttons. Only the body is stored per
 * message, so header/footer/buttons come from the template itself —
 * the static parts, which is what nearly every template uses. A media
 * header shows as a chip: the sample image isn't necessarily the one
 * that went out.
 */
function TemplateBubble({
  message,
  isAgent,
  t,
}: {
  message: Message;
  isAgent: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const tpl = useContext(TemplateLookupContext).get(message.template_name ?? "");
  const muted = isAgent ? "text-primary-foreground/75" : "text-muted-foreground";
  const divider = isAgent ? "border-primary-foreground/20" : "border-border";
  const mediaHeader =
    tpl?.header_type && tpl.header_type !== "text" ? tpl.header_type : null;

  return (
    <div className="min-w-0">
      <span
        className={cn(
          "mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
          isAgent
            ? "bg-primary-foreground/20 text-primary-foreground"
            : "bg-primary/20 text-primary",
        )}
      >
        <LayoutTemplate className="h-3 w-3" />
        {t("template")}
      </span>
      {mediaHeader && (
        <p className={cn("mt-1 inline-flex items-center gap-1 text-xs", muted)}>
          <ImageIcon className="h-3.5 w-3.5" />
          {t(mediaHeader === "image" ? "image" : mediaHeader === "video" ? "video" : "document")}
        </p>
      )}
      {tpl?.header_type === "text" && tpl.header_content && (
        <p className="mt-1 break-words text-sm font-semibold">
          <WaText text={tpl.header_content} />
        </p>
      )}
      {message.content_text ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">
          <WaText text={message.content_text} />
        </p>
      ) : (
        message.template_name && (
          <p className="mt-1 break-words text-sm italic opacity-80">
            {message.template_name}
          </p>
        )
      )}
      {tpl?.footer_text && (
        <p className={cn("mt-1 break-words text-xs", muted)}>{tpl.footer_text}</p>
      )}
      {tpl?.buttons && tpl.buttons.length > 0 && (
        <div className={cn("-mx-1 mt-2 border-t", divider)}>
          {tpl.buttons.map((btn, i) => {
            const Icon =
              btn.type === "URL"
                ? ExternalLink
                : btn.type === "PHONE_NUMBER"
                  ? Phone
                  : btn.type === "COPY_CODE"
                    ? Copy
                    : CornerDownLeft;
            return (
              <div
                key={i}
                className={cn(
                  "flex items-center justify-center gap-1.5 py-1.5 text-sm font-medium",
                  i > 0 && cn("border-t", divider),
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{btn.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
