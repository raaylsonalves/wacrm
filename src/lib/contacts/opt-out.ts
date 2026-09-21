/**
 * Opt-out detection for inbound WhatsApp messages.
 *
 * Matches a message that is asking to stop receiving messages, so the
 * webhook can flag the contact (`contacts.opted_out_at`, migration
 * 053) and future broadcasts / automations can skip them.
 *
 * Deliberately narrower than "message contains a stop word": an
 * inbound message where the customer merely uses one of these words
 * mid-sentence ("tem como parar a dor?", "cuánto para cancelar la
 * consulta?") is not a request to stop messages, and flagging it would
 * silently cut off a real conversation. A match requires one of:
 *
 *   1. The whole (trimmed) message IS a stop word, nothing else — the
 *      person typed just "parar" / "stop" / "sair".
 *   2. A cessation verb together with a communication object in the
 *      same message — "parar de me mandar", "no me escribas más",
 *      "sair da lista", "remove me from the list".
 *
 * Covers PT-BR, ES and EN. Pure and side-effect free so it can be unit
 * tested without a live message payload.
 */

// Whole-message stop words. Case/diacritics-insensitive, matched only
// when they make up the entire (trimmed) message.
const ISOLATED_STOP_WORDS = [
  // pt-BR
  'parar',
  'pare',
  'cancelar',
  'sair',
  'descadastrar',
  'descadastre',
  'desinscrever',
  // es
  'parar',
  'cancelar',
  'baja',
  'darme de baja',
  'desuscribir',
  // en
  'stop',
  'unsubscribe',
  'cancel',
  'remove',
] as const;

// Cessation verbs (infinitive/imperative stems) that only count as
// opt-out when paired with a communication object below.
const CESSATION_VERBS =
  /\b(parar?|pare|deixa(?:r|m)?|deixe|cancelar|cancele|remov(?:er|a|am|e)|tirar?|tire|sair?|saia|desinscrever|desuscrib\w*|stop|unsubscribe)\b/i;

// Communication objects — what's being stopped/removed from.
const COMMUNICATION_OBJECTS =
  /\b(mensage(?:m|ns)|mandar|enviar|escrever|contatar|contato|lista|newsletter|promo(?:ç|c)(?:ão|oes)|propaganda|mensajes?|enviarme|escribirme|contactarme|lista|messages?|texts?|list|contacting? me|messaging me)\b/i;

// Spanish negated-imperative form — "no me escribas más", "ya no me
// contactes" — where the verb carries the pronoun and negation
// instead of pairing with a standalone object noun.
const NEGATED_CONTACT_VERB =
  /\bno\s+(?:me\s+)?(?:escrib\w*|contact\w*|mand\w*|envi\w*)\b/i;

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .trim();
}

/**
 * True when `text` looks like a request to stop receiving messages.
 * Empty/whitespace-only input never matches.
 */
export function isOptOutMessage(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;

  // Strip trailing punctuation for the isolated-word check so "parar!"
  // and "stop." still count as the whole message.
  const bare = normalized.replace(/[!?.,;:]+$/, '').trim();
  if ((ISOLATED_STOP_WORDS as readonly string[]).includes(bare)) return true;

  if (
    CESSATION_VERBS.test(normalized) &&
    COMMUNICATION_OBJECTS.test(normalized)
  ) {
    return true;
  }
  return NEGATED_CONTACT_VERB.test(normalized);
}
