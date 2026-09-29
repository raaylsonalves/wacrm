# Spec: the AI answers voice notes

## Problem
A customer's voice note was stored and playable in the inbox, but the AI
never saw it: the webhook only dispatched auto-reply for text, and the
context builder only read text. To the assistant, an audio-only customer
said nothing.

## Design
Transcribe, then treat the transcript as typed text. Handoff keywords,
guardrails, follow-ups and the reply cap then apply with no special case.

- Transcription: OpenAI `gpt-4o-mini-transcribe` with the account's
  existing OpenAI key (the knowledge-base "embeddings" key on the default
  agent). No new key field. Language auto-detected.
- Runs inside `dispatchInboundToAiReply`, AFTER the eligibility gates —
  AI off / human assigned / paused never pays to transcribe.
- Stored in `messages.transcript` + `transcript_status` (migration 076),
  NOT in `content_text`, so a machine transcript never masquerades as the
  customer's own words in the inbox or the conversation list.
- `buildConversationContext` includes audio rows via the transcript,
  prefixed `[áudio transcrito]`.

## When it can't be understood (no key, download or provider failure)
1. First time: the AI says it couldn't make out the audio and asks the
   customer to write (`AiAudioNotice.retry`, 2 variants per locale). Does
   not count against the reply cap.
2. If the customer's previous message was also an unreadable audio: hand
   off, reason `audio_unintelligible`, with the usual customer notice.
3. No wording available (missing translation) → hand off, never silence.

## Not built
- Cloud API only. The WAHA webhook does not pass audio yet.
- The inbox does not show the transcript under the audio bubble (worth
  doing: a human skims text faster than they play audio).
- Opt-out phrases spoken in audio are not caught before the AI (the text
  opt-out check runs on `content_text`); the handoff keywords do apply.
- No per-account switch and no cost counter for transcription.
- Long audio: bounded only by the 16 MB media limit.
