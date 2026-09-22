'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  Plus,
  QrCode,
  Trash2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';

type ChannelStatus = 'connecting' | 'connected' | 'disconnected';

interface WahaChannel {
  id: string;
  label: string;
  status: ChannelStatus;
  waha_base_url: string;
  connected_at: string | null;
  created_at: string;
}

/** Poll cadence while a channel is waiting for the QR to be scanned. */
const POLL_MS = 3000;

const STATUS_META: Record<
  ChannelStatus,
  { icon: typeof CheckCircle2; className: string }
> = {
  connected: {
    icon: CheckCircle2,
    className: 'border-primary/40 bg-primary/10 text-primary',
  },
  connecting: {
    icon: Clock,
    className:
      'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  disconnected: {
    icon: XCircle,
    className: 'border-red-600/40 bg-red-600/10 text-red-700 dark:text-red-400',
  },
};

export function WahaChannels() {
  const t = useTranslations('Settings.waha');

  const [channels, setChannels] = useState<WahaChannel[]>([]);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [creating, setCreating] = useState(false);

  const [qrChannelId, setQrChannelId] = useState<string | null>(null);
  const [qrDataUri, setQrDataUri] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadChannels = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/waha/channels');
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setChannels(payload.channels ?? []);
    } catch {
      toast.error(t('toastLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  // While any channel is still 'connecting', poll each one's status —
  // a scan on the phone flips it to 'connected' with no push from us.
  useEffect(() => {
    const hasPending = channels.some((c) => c.status === 'connecting');
    if (!hasPending) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    if (pollRef.current) return; // already polling

    pollRef.current = setInterval(async () => {
      const pending = channels.filter((c) => c.status === 'connecting');
      for (const channel of pending) {
        try {
          const res = await fetch(`/api/whatsapp/waha/channels/${channel.id}`);
          const payload = await res.json();
          if (res.ok && payload.status !== channel.status) {
            setChannels((prev) =>
              prev.map((c) =>
                c.id === channel.id ? { ...c, status: payload.status } : c
              )
            );
            if (payload.status === 'connected') {
              toast.success(t('toastConnected', { label: channel.label }));
              if (qrChannelId === channel.id) setQrChannelId(null);
            }
          }
        } catch {
          // Transient poll failure — try again next tick.
        }
      }
    }, POLL_MS);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, t]);

  async function handleCreate() {
    if (!label.trim() || !baseUrl.trim() || !apiKey.trim()) {
      toast.error(t('toastFieldsRequired'));
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/whatsapp/waha/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(),
          waha_base_url: baseUrl.trim(),
          waha_api_key: apiKey.trim(),
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'failed');

      setChannels((prev) => [...prev, payload.channel]);
      setAddOpen(false);
      setLabel('');
      setBaseUrl('');
      setApiKey('');
      toast.success(t('toastCreated'));
      openQr(payload.channel.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastCreateFailed'));
    } finally {
      setCreating(false);
    }
  }

  async function openQr(channelId: string) {
    setQrChannelId(channelId);
    setQrDataUri(null);
    setQrError(null);
    try {
      const res = await fetch(`/api/whatsapp/waha/channels/${channelId}/qr`);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setQrDataUri(payload.qr);
    } catch (err) {
      setQrError(err instanceof Error ? err.message : t('toastQrFailed'));
    }
  }

  async function handleDelete(channel: WahaChannel) {
    if (!window.confirm(t('deleteConfirm', { label: channel.label }))) return;
    setDeletingId(channel.id);
    try {
      const res = await fetch(`/api/whatsapp/waha/channels/${channel.id}`, {
        method: 'DELETE',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setChannels((prev) => prev.filter((c) => c.id !== channel.id));
      toast.success(t('toastDeleted'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastDeleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <SettingsPanelHead
          title={t('title')}
          description={t('description')}
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              {t('addChannelBtn')}
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertTitle>{t('riskTitle')}</AlertTitle>
          <AlertDescription>{t('riskDescription')}</AlertDescription>
        </Alert>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : channels.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">
            {t('noChannels')}
          </p>
        ) : (
          <div className="space-y-2">
            {channels.map((channel) => {
              const meta = STATUS_META[channel.status];
              const StatusIcon = meta.icon;
              return (
                <div
                  key={channel.id}
                  className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {channel.label}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {channel.waha_base_url}
                    </p>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.className}`}
                  >
                    <StatusIcon className="size-3" />
                    {t(`status.${channel.status}`)}
                  </span>
                  {channel.status === 'connecting' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openQr(channel.id)}
                    >
                      <QrCode className="size-3.5" />
                      {t('showQrBtn')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={deletingId === channel.id}
                    onClick={() => handleDelete(channel)}
                    className="text-muted-foreground hover:text-red-600"
                  >
                    {deletingId === channel.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* Add channel dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('addDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('labelField')}</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t('labelPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('baseUrlField')}</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://waha.example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('apiKeyField')}</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t('apiKeyHint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t('cancelBtn')}
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" />
              )}
              {t('connectBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR dialog */}
      <Dialog
        open={qrChannelId !== null}
        onOpenChange={(open) => !open && setQrChannelId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('qrDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-4">
            {qrError ? (
              <Badge variant="outline" className="text-red-600">
                {qrError}
              </Badge>
            ) : qrDataUri ? (
              // eslint-disable-next-line @next/next/no-img-element -- data: URI from WAHA, not a local asset next/image can optimize
              <img
                src={qrDataUri}
                alt={t('qrAlt')}
                className="size-56 rounded-lg"
              />
            ) : (
              <Loader2 className="text-muted-foreground size-8 animate-spin" />
            )}
            <p className="text-muted-foreground text-center text-sm">
              {t('qrInstructions')}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
