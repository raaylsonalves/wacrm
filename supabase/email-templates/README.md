# Supabase Auth e-mail templates (pt-BR)

Paste each file into Supabase → Authentication → Emails → Templates.
Variables (`{{ .ConfirmationURL }}`, `{{ .Token }}`, …) are Supabase's.
Sent through custom SMTP (Resend).

| Template (Supabase) | File | Subject |
|---|---|---|
| Confirm signup | `confirm-signup.html` | Confirme seu cadastro no Nordia CRM |
| Invite user | `invite.html` | Você foi convidado para o Nordia CRM |
| Magic link | `magic-link.html` | Seu link de acesso ao Nordia CRM |
| Change email address | `change-email.html` | Confirme seu novo e-mail no Nordia CRM |
| Reset password | `reset-password.html` | Redefina sua senha do Nordia CRM |
| Reauthentication | `reauthentication.html` | Seu código de verificação do Nordia CRM |
