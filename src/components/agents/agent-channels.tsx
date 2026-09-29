'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface ChannelRow {
  channelId: string | null;
  label: string;
  boundAgentId: string | null;
  boundAgentName: string | null;
  mine: boolean;
}

/**
 * The numbers an agent answers on (specs/ai-agents-management.md;
 * migration 074). One agent per number: ticking a number another agent
 * holds MOVES it, and says so before saving. A number nobody holds keeps
 * falling through to the router / default agent, as before.
 *
 * This is what makes the same account run different personas on
 * different numbers — a barbershop's number and a clinic's number, or an
 * operator's several clients' numbers.
 */
export function AgentChannels({
  agentId,
  canEdit,
}: {
  agentId: string;
  canEdit: boolean;
}) {
  const t = useTranslations('Agents.detail.channels');
  const [rows, setRows] = useState<ChannelRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const keyOf = (c: string | null) => c ?? 'cloud';

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ai/agents/${agentId}/channels`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'failed');
      const list = (data.channels ?? []) as ChannelRow[];
      setRows(list);
      setSelected(new Set(list.filter((r) => r.mine).map((r) => keyOf(r.channelId))));
    } catch {
      setRows([]);
      toast.error(t('loadFailed'));
    }
  }, [agentId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/ai/agents/${agentId}/channels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_ids: [...selected].map((k) => (k === 'cloud' ? null : k)),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'failed');
      toast.success(t('saved'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {rows.map((r) => {
                const key = keyOf(r.channelId);
                const checked = selected.has(key);
                const heldByOther = r.boundAgentId && !r.mine;
                return (
                  <li
                    key={key}
                    className="border-border bg-muted/30 flex items-start gap-3 rounded-lg border p-3"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!canEdit}
                      onCheckedChange={(v) => toggle(key, v === true)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground text-sm font-medium">
                        {r.label === 'cloud_api' ? t('cloudApi') : r.label}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {heldByOther
                          ? checked
                            ? t('willMove', { name: r.boundAgentName ?? '—' })
                            : t('heldBy', { name: r.boundAgentName ?? '—' })
                          : checked
                            ? t('thisAgent')
                            : t('fallsThrough')}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
            {canEdit && (
              <Button size="sm" onClick={save} disabled={saving}>
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                {t('save')}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
