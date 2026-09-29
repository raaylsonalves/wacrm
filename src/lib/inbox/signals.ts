/**
 * What a glance at a conversation row should tell (ported in spirit from
 * deskcomm's `comando-da-conversa` and `janela`). Pure.
 */

export type Command = 'human' | 'ai' | 'waiting' | 'nobody' | 'closed'

/**
 * Who is in charge of this conversation right now. The colour comes from
 * WHO ANSWERS, not from the status field: a thread the AI handles end to
 * end is "open" all along, and a handed-off one is "open" too — the status
 * alone can't tell them apart.
 *
 *  - closed  — the conversation is closed;
 *  - human   — a person is assigned;
 *  - waiting — the AI stopped (hand-off or paused) and nobody took it: the
 *              one state that needs someone to act;
 *  - ai      — the account's AI answers this thread;
 *  - nobody  — no AI and no person (or we don't know whether AI is on).
 */
export function commandOf(args: {
  status: string
  assignedAgentId?: string | null
  aiAutoreplyDisabled?: boolean | null
  /** Account-wide: is any AI agent auto-replying? undefined = unknown. */
  aiOn?: boolean
}): Command {
  if (args.status === 'closed') return 'closed'
  if (args.assignedAgentId) return 'human'
  if (args.aiAutoreplyDisabled) return 'waiting'
  if (args.aiOn) return 'ai'
  return 'nobody'
}

export const COMMAND_DOT: Record<Command, string> = {
  human: 'bg-blue-500',
  ai: 'bg-purple-500',
  waiting: 'bg-amber-500',
  nobody: 'bg-muted-foreground/60',
  closed: 'bg-muted-foreground/30',
}

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000
/** Under this, the open window is shown as urgent. */
export const WINDOW_URGENT_MS = 2 * 60 * 60 * 1000

export type WindowState =
  | { kind: 'none' }
  | { kind: 'open'; remainingMs: number; urgent: boolean }
  | { kind: 'closed'; closedForMs: number | null }

/**
 * WhatsApp's 24h customer-service window. Only the official API enforces
 * it (past 24h only an approved template goes out); a WAHA conversation
 * has no such rule, so it gets no badge at all.
 */
export function windowState(args: {
  isOfficialApi: boolean
  lastCustomerMessageAt: string | null | undefined
  now: Date
}): WindowState {
  if (!args.isOfficialApi) return { kind: 'none' }
  if (!args.lastCustomerMessageAt) return { kind: 'closed', closedForMs: null }
  const elapsed = args.now.getTime() - new Date(args.lastCustomerMessageAt).getTime()
  const remaining = SESSION_WINDOW_MS - elapsed
  if (remaining > 0) return { kind: 'open', remainingMs: remaining, urgent: remaining <= WINDOW_URGENT_MS }
  return { kind: 'closed', closedForMs: -remaining }
}

/** "2h", "35min", "3d" — compact, for a badge. */
export function formatSpan(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min}min`
  const h = Math.round(min / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/** Initials from a display name ("Ana Souza" → "AS"); phone → first two digits. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
