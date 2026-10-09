// The e-mail look shared with the Supabase Auth templates
// (supabase/email-templates/): grey page, white card, logo, plain text,
// one dark button. Table layout + inline styles for e-mail clients.

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, '') ||
    'https://crm.nordiatech.com.br'
  );
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A paragraph block; `html` is trusted markup built by the caller. */
export function para(html: string): string {
  return `<p style="margin:0 0 16px 0;">${html}</p>`;
}

export function small(html: string): string {
  return `<p style="margin:0 0 16px 0;font-size:14px;line-height:22px;color:#687385;">${html}</p>`;
}

export function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr><td style="border-radius:8px;background:#1a1b25;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;font-weight:600;font-size:15px;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a></td></tr></table>`;
}

/** Label / value rows, e.g. the amount and date of a charge. */
export function details(rows: [string, string][]): string {
  const tr = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#687385;font-size:14px;">${escapeHtml(k)}</td><td align="right" style="padding:6px 0;font-size:14px;font-weight:600;color:#1a1b25;">${escapeHtml(v)}</td></tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;border-top:1px solid #ebeef1;border-bottom:1px solid #ebeef1;">${tr}</table>`;
}

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f6f9fc;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f9fc;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;">
<tr><td style="padding:40px 48px 8px 48px;"><img src="${siteUrl()}/landing/nordia-logo.png" width="120" alt="Nordia CRM" style="display:block;border:0;height:auto;"></td></tr>
<tr><td style="padding:24px 48px 40px 48px;font-family:${FONT};font-size:16px;line-height:26px;color:#414552;">
${body}
<p style="margin:32px 0 0 0;">Equipe Nordia</p>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;"><tr><td style="padding:24px 48px;font-family:${FONT};font-size:12px;line-height:18px;color:#8792a2;">
Nordia Tech · <a href="https://nordiatech.com.br" style="color:#8792a2;">nordiatech.com.br</a><br>Você recebeu este e-mail por causa da sua conta no Nordia CRM.
</td></tr></table>
</td></tr></table>
</body></html>`;
}
