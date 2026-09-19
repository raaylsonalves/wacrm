# Spec: AI understands customer audio (voice note) messages

## Problem

A customer can send a WhatsApp voice note today, and it's stored fine
(`messages.content_type = 'audio'`, media mirrored to Storage per
migration 039), but the AI never sees it. Two independent gaps:

- `buildConversationContext` (`src/lib/ai/context.ts:24-30`) selects
  only `.eq('content_type', 'text')` — an audio message is silently
  excluded from the transcript built for the model. If the audio is
  the customer's only message, `messages.length === 0` and
  `dispatchInboundToAiReply` bails out entirely (`auto-reply.ts:148`),
  so the bot never even attempts a reply.
- None of the three provider adapters (`src/lib/ai/providers/{openai,
  anthropic,gemini}.ts`) build anything but a text-only request body —
  there is no code path to send audio to any of them even if it
  reached that far.

Confirmed by direct code read during a prior conversation (not
guessed): both gaps are real, independent, and both need closing.

## Non-goals

- Voice *replies* from the bot (text-to-speech) — this spec is
  input-only: understanding what the customer said, replying in text
  as today.
- Real-time/streaming transcription — a voice note is a finished
  audio file by the time it lands in Storage; batch transcription is
  sufficient.
- Sending images/documents/video to the AI — same class of problem
  (non-text content excluded from context) but a separate spec; audio
  is the one the business actually needs right now (loan customers
  sending voice notes instead of typing).
- Building a proprietary/self-hosted transcription pipeline — reuse an
  existing hosted transcription API behind the account's own BYO key.

## Current behavior

- `src/lib/ai/context.ts`: `buildConversationContext` fetches
  `sender_type, content_text` filtered to `content_type = 'text'`
  only, ordered and limited, mapped to `ChatMessage[]`.
- `messages` schema (migration 001 + 039): `content_type` can be
  `'audio'`; `media_url` points at the mirrored Storage object;
  `content_text` is `NULL` for a pure audio message (nothing
  transcribes it today).
- `src/lib/ai/providers/gemini.ts`'s `toGeminiContents` builds
  `{ role, parts: [{ text }] }` only — Gemini's own API *does* support
  inline audio parts (`parts: [{ inline_data: { mime_type, data } }]`)
  natively, but nothing in this adapter constructs that.
- OpenAI and Anthropic adapters are equally text-only; neither
  Chat Completions/Messages endpoint accepts inline audio the way
  Gemini's does — audio there would need a separate transcription call
  first regardless.

## Proposed change

Transcribe-then-text, provider-agnostic — works the same regardless of
which of the 3 providers the account has configured, and requires no
per-provider request-shape branching in the reply-generation path:

1. **New transcription step in the webhook's media-handling path**
   (`src/app/api/whatsapp/webhook/route.ts`, where inbound audio is
   already downloaded and mirrored to Storage): after the mirror
   succeeds for an audio message, best-effort call a transcription API
   and persist the result into `messages.content_text` for that row
   (column already exists and is nullable — no schema change needed
   there). Fire from `after()` alongside the existing fan-out so it
   never blocks the webhook's 200 to Meta; failures are logged and
   leave `content_text` `NULL` (falls back to today's behavior of
   being excluded from context, not a crash).
2. **Transcription provider**: reuse whichever key the account already
   has configured rather than inventing a 4th BYO-key field —
   - OpenAI account → OpenAI's audio transcription endpoint
     (Whisper-based), using the same decrypted `api_key`.
   - Gemini account → Gemini's own `generateContent` with an inline
     `audio` part and a "transcribe this" instruction — no second
     provider needed.
   - Anthropic account → Anthropic has no audio endpoint; either skip
     transcription (leave `content_text` `NULL`, same as today) or
     require an OpenAI key specifically for transcription. Flagged in
     Risks below — needs a decision.
   New small module, e.g. `src/lib/ai/transcribe.ts`, exporting
   `transcribeAudio(config: AiConfig, mediaUrl: string):
   Promise<string | null>`, dispatching on `config.provider`.
3. **`buildConversationContext` change**: widen the `content_type`
   filter from `.eq('content_type', 'text')` to
   `.in('content_type', ['text', 'audio'])`, keep the existing
   `.filter((m) => m.content_text && m.content_text.trim())` guard
   (already handles a `NULL`/untranscribed audio row correctly — it's
   just dropped, exactly like today). No other change needed in
   `context.ts`; the rest of the pipeline (knowledge retrieval, prompt
   building, generation) is already text-shaped and needs nothing
   audio-specific once `content_text` is populated.
4. Optionally mark transcribed messages distinctly in the transcript
   passed to the model (e.g. prefix `[áudio transcrito] ` before the
   text) so the model doesn't treat a possibly-imperfect transcription
   as verbatim typed text — cheap to add, helps the model hedge
   ("Só confirmando, você disse que...") when the transcription looks
   garbled.

## Acceptance criteria

- [ ] An inbound WhatsApp voice note gets a `content_text` populated
      within a short time of arriving (best-effort; a failure leaves
      it `NULL`, doesn't retry indefinitely, doesn't throw from the
      webhook).
- [ ] `buildConversationContext` includes transcribed audio messages
      in the transcript sent to the AI, in the correct chronological
      position relative to text messages.
- [ ] `dispatchInboundToAiReply` no longer bails out
      (`messages.length === 0`) when the only inbound content is a
      successfully-transcribed voice note.
- [ ] The AI's reply to a voice note is grounded in the transcribed
      content (verified manually with a real test voice note per
      provider configured).
- [ ] An account whose configured provider can't transcribe (Anthropic,
      pending the Risks decision) degrades to today's behavior — no
      reply attempted from audio alone — rather than erroring.

## Risks / open questions

- **Anthropic accounts**: no first-party transcription endpoint. Needs
  an explicit decision: (a) silently skip transcription for
  Anthropic-configured accounts, (b) let the account paste a
  transcription-only OpenAI key even if their reply model is Claude,
  or (c) treat this as a reason to nudge those accounts toward Gemini
  or OpenAI for full audio support. Recommend (a) for v1 — simplest,
  no new UI — and revisit if an Anthropic-only customer actually asks.
- **Cost**: every voice note becomes an extra billed API call (Whisper
  or Gemini) on top of the reply generation call, on the account's own
  key — worth surfacing in the UI/docs so an account doesn't get
  surprised by usage, similar to how `logAiUsage` already tracks reply
  generation spend today (transcription calls should probably be
  logged there too, as their own `mode`).
- **Transcription latency**: adds a network round trip before the
  reply can even start generating; for a long voice note this could
  meaningfully delay the "typing…" → reply cycle. Worth timing during
  implementation and deciding if a "this is taking a while" filler
  message is warranted for long audio.
- **Non-Portuguese transcription accuracy**: not a concern for Agius
  specifically, but worth noting for other forks — Whisper/Gemini both
  auto-detect language, no config needed, but low-quality/noisy
  WhatsApp voice notes will produce worse transcripts than clean audio.
