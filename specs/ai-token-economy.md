# Spec: spending fewer tokens (pay-as-you-go)

The AI runs on each account's own key, billed per token. Every turn sends
the whole prompt again, so cost = (prompt size) × (number of turns) +
output. Levers, ranked by saving ÷ risk. No numbers are quoted: measure
first with the Usage tab (`ai_usage_log`), which already records tokens
per call and per agent.

## What one turn sends today (read from the code)
- System prompt: fixed scaffold + contact-name line + agenda-tool text +
  the account's business context + retrieved knowledge excerpts
  (`buildSystemPrompt`, `defaults.ts`).
- The last **20** messages (`aiContextMessageLimit`, env
  `AI_CONTEXT_MESSAGE_LIMIT`), text/interactive/transcribed audio.
- Output capped at **1024** tokens (`MAX_OUTPUT_TOKENS`).
- Tool schemas only when agenda tools are on; up to `MAX_TOOL_ROUNDS`
  provider round trips per turn (each re-sends everything).

## Levers

1. **Skip pure acknowledgments** — BUILT (`src/lib/ai/ack.ts`). An "ok",
   "blz", "👍" or "obrigado" needs no model call. "Thanks" gets a canned
   line (`AiAckNotice.thanks`), the rest gets nothing.
   Guards, because a wrong skip costs more than the tokens: never when the
   last thing the business sent contained a "?" or was an interactive
   prompt (an "ok" there IS the answer); never on the conversation's first
   AI reply; allow-listed emoji only (😡 and ❓ are answered); any unknown
   word means "not an acknowledgment".
2. **Coalesce bursts** — BUILT (`src/lib/ai/burst.ts`). Every dispatch
   waits a quiet period (default 4 s, env `AI_REPLY_DEBOUNCE_MS`, `0`
   turns it off, capped at 15 s); only the dispatch of the NEWEST customer
   message answers, with the whole burst in its context. No queue or cron:
   the wait is the webhook's own `after()` work.
   - A dispatch identifies its own message by wamid, so a message that
     arrived before it even looked still counts as newer.
   - A voice note superseded by a later message is still transcribed, so
     the surviving dispatch reads it.
   - A button/list tap answers immediately (`immediate`).
   - After the wait it re-reads the thread: a person assigned, or a
     handoff, in the meantime means it stands down.
   - Fails open: a broken lookup answers rather than dropping the
     customer.
   - Cost of the feature: every reply is delayed by the quiet period
     (which also reads as more human), and a process that dies during the
     wait leaves that message unanswered until the customer writes again.
   - A message landing in the instant between the check and the send can
     still produce two replies — the same exposure as before this
     existed, now much rarer.
   - Not built: a per-agent setting for the delay (env only).
3. **Make the prompt cacheable** — BUILT for the automatic caches
   (`buildSystemPrompt`, locked by `defaults.test.ts`). Order is now
   scaffold → agenda text → business context → contact name → knowledge
   excerpts: everything that is the same for every customer comes first,
   so the repeated prefix is as long as possible (OpenAI and Gemini cache
   a stable prefix on their own; OpenRouter passes it to the model behind).
   - NOT done: Anthropic needs explicit `cache_control` markers and a
     system prompt split into a stable block and a volatile one, which
     means threading two strings through generate → fallback → adapter.
     Worth doing only for an account on Anthropic, and only if the stable
     part clears the model's minimum cacheable size (about 1-2k tokens).
   - NOT verified: whether it saves anything is visible only if the
     cached-token count is recorded; `ai_usage_log` keeps prompt and
     completion tokens, not the cached share. Add that column before
     promising a number.
4. **Shorter history.** 20 turns is generous for WhatsApp. A per-agent
   setting (default ~12) or a character budget instead of a message count;
   summarising older turns is the heavier option.
5. **Lower the output cap** (1024 → ~400). WhatsApp answers are short and
   the cap is also the last defence against essays (see the 4,402-character
   reply). Caveat: reasoning models spend the cap on thinking — exclude
   reasoning (`generate.ts`/OpenRouter already asks) or the cap can starve
   the answer.
6. **Retrieve knowledge only when useful.** `retrieveKnowledge` runs for
   every turn that has any chunks. Skip it for social messages and cap the
   excerpt size; k and chunk length are the dials.
7. **Small model by default, bigger only when needed** (agenda tools,
   angry customer). Needs a trigger rule; measure first. See
   `specs/ai-voice-replies.md` for the per-job model split.
8. **Canned answers before the model.** Hours, address, "send the
   catalog": a small table of trigger → fixed reply, like the handoff
   keywords. Zero tokens, and consistent.
9. **Visibility.** Cost per conversation / per agent on the Usage tab
   (OpenRouter returns prices; other providers don't, so no invented
   price table — show tokens, and cost only where the provider supplies
   the price).

## Suggested order (1-3 are built)
4 (history) → 5 (output cap) →
6 → 8. Build 7 only if usage data shows the big model dominates.

## Not doing
- Truncating the business context to save tokens: it is the product.
- A hard-coded price table (goes stale, and the picker rule already
  forbids it).
