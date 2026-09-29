# Spec: one model per job — and answering in voice

> Follows `specs/ai-audio-inbound.md` (the AI understands voice notes).
> Three jobs, each with its own model and cost, instead of one model for
> everything.

## The three jobs

| Job | What it does | Model today |
|---|---|---|
| **Text** | writes the reply | the agent's `model` (already separate) |
| **Listen** | transcribes the customer's voice note | `ai_configs.transcription_model` (phase 1) |
| **Speak** | turns the reply into a voice note | phase 2 |

A job with nothing chosen falls back to today's behaviour, so nothing
changes for an agent that touches none of it.

## Phase 1 — pick the listening model (BUILT, migration 077)

- `ai_configs.transcription_model` (NULL = default `gpt-4o-mini-transcribe`).
- Allow-list in `src/lib/ai/transcribe.ts` (`TRANSCRIPTION_MODELS`), not a
  CHECK: a new model needs a code change, not a migration, and an unknown
  stored value degrades to the default instead of failing every voice note.
- Field on the agent edit page and on the default agent's form.
- Still uses the account's OpenAI key (the knowledge-base key). Not
  configurable per provider yet.
- The text model needed no work: it is the agent's existing `model`, and
  a small text-only model there is exactly the point.

## Phase 2 — answer in voice (pipeline)  [BUILT, migration 079 — see notes below]

Reply text → text-to-speech → WhatsApp voice note. Text is produced and
**guardrailed first** (`specs/ai-output-guardrails.md`), then spoken, so a
blocked reply is never voiced.

- Per agent: `voice_reply_mode` = `off` (default) | `mirror` (answer with
  voice only when the customer's last message was a voice note) | `always`.
  `mirror` is the recommended default once on: customers who talk expect
  to be answered by voice, customers who type do not.
- Per agent: TTS model + voice (`voice_model`, `voice_name`), allow-listed
  like the transcription models. Needs an OpenAI key (same key).
- **WhatsApp wants a voice note** (`audio/ogg; codecs=opus`). Ask the TTS
  for `opus` output where the API offers it; mp3/wav needs a conversion
  step (ffmpeg is not available on the serverless runtime — verify the
  target first; this is the riskiest piece).
- Upload the audio (Meta media upload → send `type: audio`), and store the
  outbound message with `content_type='audio'` plus the **text**, so the
  inbox shows what was said.
- Length cap: speak at most ~600 characters; longer replies go out as
  text (a 2-minute voice monologue is worse than text). Long-reply
  splitting (`split-long.ts`) applies to the text fallback.
- Cost: TTS bills per character and is the most expensive job; the Usage
  tab must count it separately from text tokens.
- Failure: if TTS or the upload fails, send the text — never silence.
- Opt-in per agent, off by default, with a "listen to a sample" button in
  settings so the owner hears the voice before enabling it.

## Phase 3 — native audio model (any-to-any)  [not built]

An audio-in / audio-out model (e.g. OpenAI `gpt-4o-audio`, Gemini native
audio) receives the customer's audio and answers in audio in one call.
More natural and faster, but:

- **No text to guardrail before it is spoken.** Either transcribe the
  answer afterwards and observe-only (traces), or keep the pipeline for
  accounts that need enforcement. Decide before building.
- Provider support is uneven; OpenRouter exposes it for few models.
- Costs more per turn than the pipeline.

Only worth building if phase 2 shows the pipeline's latency or voice
quality is the bottleneck.

## Acceptance (phase 1)
- [x] An agent's chosen transcription model is used for its voice notes.
- [x] An unknown/absent value uses the default.
- [x] The choice saves from both the default agent and other agents.
- [x] Schema assertion in `verify-schema.sql`; four locales.

## Open questions
- OGG/Opus output from the chosen TTS, or a conversion path? (phase 2 gate)
- Should `mirror` be the only voice mode at first? (leaning yes)
- Per-agent voice vs per-account voice for a small business with several
  agents.

## Phase 2 implementation notes

- `src/lib/ai/voice-reply.ts`: `gpt-4o-mini-tts`, `response_format: opus`,
  9 allow-listed voices (default `coral`), `mirror` mode only, 600-char cap.
- Uploaded to `chat-media/<account>/ai-voice/`, sent as `type: audio` by
  link; the row keeps the text in `content_text`, `ai_generated = true`.
- Any failure (no key, TTS, upload, Meta) sends the text instead.
- Key: the agent's own key when its provider is OpenAI, else the
  knowledge-base key. Same rule now applies to transcription, which was
  failing for an account on OpenAI with the knowledge-base key empty.
- NOT verified live: that WhatsApp renders OpenAI's `opus` output as a
  voice note. If it arrives as a file or is refused, the container needs
  checking (Ogg vs raw Opus).
- Not built: "listen to a sample" button, `always` mode, TTS cost on the
  Usage tab (speech is billed per character, not recorded yet), WAHA.
