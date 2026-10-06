'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CalendarCog, Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { confirmDialog } from '@/components/confirm-dialog';

interface State {
  source: 'env' | 'database' | null;
  client_id: string | null;
  redirect_uri: string;
}

/**
 * "Google Agenda da instalação" on the portfolio (migration 097): the agency
 * owner pastes the OAuth client created in Google Cloud Console, so no one
 * edits the server's env. Renders nothing for anyone else (the API answers
 * 403). Shows the redirect URI to register in the console.
 */
export function GoogleOAuthSettings() {
  const t = useTranslations('Operator.googleOAuth');
  const [state, setState] = useState<State | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/platform/google-oauth', {
      cache: 'no-store',
    });
    setState(res.ok ? ((await res.json()) as State) : null);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!state) return null;

  async function save() {
    setSaving(true);
    const res = await fetch('/api/platform/google-oauth', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: secret }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      return toast.error(
        t.has(`errors.${d.error}`)
          ? t(`errors.${d.error}`)
          : t('errors.save_failed')
      );
    }
    toast.success(t('saved'));
    setClientId('');
    setSecret('');
    void load();
  }

  async function remove() {
    await confirmDialog(t('confirmRemove'), {
      action: async () => {
        await fetch('/api/platform/google-oauth', { method: 'DELETE' });
        void load();
      },
    });
  }

  return (
    <section className="bg-card space-y-3 rounded-xl border p-4">
      <div>
        <h2 className="text-foreground flex items-center gap-2 font-semibold">
          <CalendarCog className="text-primary h-5 w-5" />
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <p className="text-sm break-all">
        {state.source === 'env'
          ? t('fromEnv', { id: state.client_id ?? '' })
          : state.source === 'database'
            ? t('fromDb', { id: state.client_id ?? '' })
            : t('none')}
      </p>

      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">{t('redirectLabel')}</p>
        <div className="flex items-center gap-2">
          <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs">
            {state.redirect_uri}
          </code>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={t('copy')}
            onClick={() => {
              void navigator.clipboard.writeText(state.redirect_uri);
              toast.success(t('copied'));
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {state.source !== 'env' && (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={t('clientId')}
            autoComplete="off"
          />
          <Input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={t('clientSecret')}
            type="password"
            autoComplete="new-password"
          />
          <Button
            type="submit"
            disabled={saving || !clientId.trim() || !secret.trim()}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {state.source === 'database' ? t('replace') : t('save')}
          </Button>
        </form>
      )}
      {state.source === 'database' && (
        <Button variant="ghost" size="sm" onClick={() => void remove()}>
          {t('remove')}
        </Button>
      )}
    </section>
  );
}
