// Transactional e-mail through Resend (https://resend.com/docs/api-reference).
// The same Resend account is the custom SMTP of Supabase Auth, so sign-up /
// password e-mails and the app's own e-mails share one sender and domain.
//
// Never throws: a failed e-mail must not break the flow that triggered it
// (a payment is applied whether or not its receipt goes out). Without
// RESEND_API_KEY it is a no-op — forks and local dev send nothing.

const ENDPOINT = 'https://api.resend.com/emails';

export const EMAIL_FROM =
  process.env.EMAIL_FROM?.trim() || 'Nordia <nao-responda@nordiatech.com.br>';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend idempotency key: the same key within 24h is sent once. */
  idempotencyKey?: string;
}

export async function sendEmail(email: OutgoingEmail): Promise<boolean> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return false;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(email.idempotencyKey
          ? { 'Idempotency-Key': email.idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('[email] Resend refused:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[email] send failed:', err);
    return false;
  }
}
