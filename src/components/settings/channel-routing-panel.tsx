'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { createClient } from '@/lib/supabase/client';

interface ChannelRow {
  channelId: string | null;
  label: string;
  restricted: boolean;
  responsibleUserIds: string[];
}

interface MemberOption {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

export function ChannelRoutingPanel() {
  const t = useTranslations('Settings.channelRouting');

  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState<ChannelRow | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/channel-routing');
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
    load();
  }, [load]);

  // Profiles, same RLS-scoped direct select the assign dropdowns use —
  // this panel only needs names to render checkboxes, not the fuller
  // shape /api/account/members returns.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    supabase
      .from('profiles')
      .select('user_id, full_name, email')
      .order('full_name')
      .then(({ data }) => {
        if (!cancelled) setMembers((data as MemberOption[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openEditor(channel: ChannelRow) {
    setEditing(channel);
    setSelected(new Set(channel.responsibleUserIds));
  }

  function toggle(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings/channel-routing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_id: editing.channelId,
          user_ids: Array.from(selected),
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setChannels((prev) =>
        prev.map((c) =>
          c.channelId === editing.channelId
            ? {
                ...c,
                restricted: true,
                responsibleUserIds: Array.from(selected),
              }
            : c
        )
      );
      toast.success(t('toastSaved'));
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!editing) return;
    setSaving(true);
    try {
      const params = new URLSearchParams();
      if (editing.channelId) params.set('channel_id', editing.channelId);
      const res = await fetch(
        `/api/settings/channel-routing?${params.toString()}`,
        {
          method: 'DELETE',
        }
      );
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setChannels((prev) =>
        prev.map((c) =>
          c.channelId === editing.channelId
            ? { ...c, restricted: false, responsibleUserIds: [] }
            : c
        )
      );
      toast.success(t('toastCleared'));
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastClearFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <SettingsPanelHead title={t('title')} description={t('description')} />
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : (
          channels.map((channel) => {
            // The single official number (or the legacy slot) carries the
            // 'cloud_api' label; several official numbers carry their names.
            const isCloudApi =
              channel.channelId === null || channel.label === 'cloud_api';
            const label = isCloudApi ? t('cloudApiLabel') : channel.label;
            return (
              <div
                key={channel.channelId ?? 'cloud-api'}
                className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-sm font-medium">
                    {label}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {!channel.restricted
                      ? t('stateUnrestricted')
                      : channel.responsibleUserIds.length === 0
                        ? t('stateEmpty')
                        : t('stateRestricted', {
                            count: channel.responsibleUserIds.length,
                          })}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openEditor(channel)}
                >
                  <Users className="size-3.5" />
                  {t('configureBtn')}
                </Button>
              </div>
            );
          })
        )}
      </CardContent>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('dialogTitle', {
                label:
                  editing?.channelId === null ||
                  editing?.label === 'cloud_api'
                    ? t('cloudApiLabel')
                    : (editing?.label ?? ''),
              })}
            </DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">
            {t('dialogDescription')}
          </p>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {members.length === 0 ? (
              <p className="text-muted-foreground py-4 text-sm">
                {t('noMembers')}
              </p>
            ) : (
              members.map((member) => (
                <label
                  key={member.user_id}
                  className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm"
                >
                  <Checkbox
                    checked={selected.has(member.user_id)}
                    onCheckedChange={() => toggle(member.user_id)}
                  />
                  <span className="text-foreground truncate">
                    {member.full_name || member.email || member.user_id}
                  </span>
                </label>
              ))
            )}
          </div>
          <DialogFooter className="justify-between sm:justify-between">
            <Button variant="ghost" onClick={handleClear} disabled={saving}>
              {t('clearBtn')}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setEditing(null)}
                disabled={saving}
              >
                {t('cancelBtn')}
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                {t('saveBtn')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
