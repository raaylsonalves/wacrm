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
2. **Coalesce bursts.** Customers send 3 short messages in 10 seconds;
   each can trigger its own paid reply. Wait a few seconds after the last
   inbound and answer once. Biggest likely win *and* a better experience;
   needs a delayed job (the follow-up cron/sweep machinery can carry it)
   and care with the reply-slot claim.
3. **Make the prompt cacheable.** Providers discount a repeated prompt
   prefix (Anthropic needs explicit `cache_control` markers; OpenAI and
   Gemini cache stable prefixes automatically). Order the prompt
   most-static-first: scaffold → business context → agenda text →
   *then* the per-customer name → *then* retrieved excerpts. Today the
   contact-name line sits before the business context, which makes the
   prefix differ per customer and defeats cross-conversation caching.
   Cheap change; verify with the usage rows.
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

## Suggested order
2 (bursts) → 3 (prompt order/cache) → 4 (history) → 5 (output cap) →
6 → 8. Build 7 only if usage data shows the big model dominates.

## Not doing
- Truncating the business context to save tokens: it is the product.
- A hard-coded price table (goes stale, and the picker rule already
  forbids it).
