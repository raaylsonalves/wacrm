'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, Trash2, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import type { AiAgentSummary } from './ai-agents-list';

interface RouterMember {
  agent_id: string;
  intent_name: string;
  intent_description: string;
  examples: string[];
}

interface RouterRow {
  id: string;
  channel_id: string | null;
  name: string;
  is_active: boolean;
  min_confidence: number;
  sticky: boolean;
  fallback_agent_id: string | null;
  members: RouterMember[];
}

interface WahaChannelOption {
  id: string;
  label: string;
}

/** No-channel sentinel for the <Select> — base-ui/react's Select
 *  can't use an empty-string item value. */
const WHOLE_ACCOUNT = '__whole_account__';
const NO_FALLBACK = '__no_fallback__';

export function AiRouters({ agents }: { agents: AiAgentSummary[] }) {
  const t = useTranslations('Agents.multi');

  const [routers, setRouters] = useState<RouterRow[]>([]);
  const [channels, setChannels] = useState<WahaChannelOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newChannel, setNewChannel] = useState(WHOLE_ACCOUNT);

  const [editingRouter, setEditingRouter] = useState<RouterRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [minConfidence, setMinConfidence] = useState('0.6');
  const [sticky, setSticky] = useState(true);
  const [fallbackAgentId, setFallbackAgentId] = useState(NO_FALLBACK);
  const [members, setMembers] = useState<RouterMember[]>([]);

  const load = useCallback(async () => {
    try {
      const [routersRes, channelsRes] = await Promise.all([
        fetch('/api/ai/routers'),
        fetch('/api/whatsapp/waha/channels'),
      ]);
      const routersPayload = await routersRes.json();
      if (!routersRes.ok) throw new Error(routersPayload?.error || 'failed');
      setRouters(routersPayload.routers ?? []);
      const channelsPayload = await channelsRes
        .json()
        .catch(() => ({ channels: [] }));
      setChannels(channelsPayload.channels ?? []);
    } catch {
      toast.error(t('toastRoutersLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    if (!newName.trim()) {
      toast.error(t('toastFieldsRequired'));
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/ai/routers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          channel_id: newChannel === WHOLE_ACCOUNT ? null : newChannel,
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setRouters((prev) => [...prev, payload.router]);
      setAddOpen(false);
      setNewName('');
      setNewChannel(WHOLE_ACCOUNT);
      toast.success(t('toastCreated'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastCreateFailed'));
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(router: RouterRow) {
    try {
      const res = await fetch(`/api/ai/routers/${router.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !router.is_active }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setRouters((prev) =>
        prev.map((r) =>
          r.id === router.id ? { ...r, is_active: !r.is_active } : r
        )
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastUpdateFailed'));
    }
  }

  async function handleDelete(router: RouterRow) {
    if (!window.confirm(t('deleteRouterConfirm', { name: router.name })))
      return;
    try {
      const res = await fetch(`/api/ai/routers/${router.id}`, {
        method: 'DELETE',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setRouters((prev) => prev.filter((r) => r.id !== router.id));
      toast.success(t('toastDeleted'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastDeleteFailed'));
    }
  }

  function openEditor(router: RouterRow) {
    setEditingRouter(router);
    setMinConfidence(String(router.min_confidence));
    setSticky(router.sticky);
    setFallbackAgentId(router.fallback_agent_id ?? NO_FALLBACK);
    setMembers(router.members.length > 0 ? router.members : []);
  }

  function addMemberRow() {
    setMembers((prev) => [
      ...prev,
      {
        agent_id: agents[0]?.id ?? '',
        intent_name: '',
        intent_description: '',
        examples: [],
      },
    ]);
  }

  function updateMember(index: number, patch: Partial<RouterMember>) {
    setMembers((prev) =>
      prev.map((m, i) => (i === index ? { ...m, ...patch } : m))
    );
  }

  function removeMember(index: number) {
    setMembers((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSaveEditor() {
    if (!editingRouter) return;
    const confidence = Number(minConfidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      toast.error(t('toastConfidenceInvalid'));
      return;
    }
    for (const m of members) {
      if (
        !m.agent_id ||
        !m.intent_name.trim() ||
        !m.intent_description.trim()
      ) {
        toast.error(t('toastIntentFieldsRequired'));
        return;
      }
    }
    setSaving(true);
    try {
      const patchRes = await fetch(`/api/ai/routers/${editingRouter.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          min_confidence: confidence,
          sticky,
          fallback_agent_id:
            fallbackAgentId === NO_FALLBACK ? '' : fallbackAgentId,
        }),
      });
      const patchPayload = await patchRes.json();
      if (!patchRes.ok) throw new Error(patchPayload?.error || 'failed');

      const membersRes = await fetch(
        `/api/ai/routers/${editingRouter.id}/members`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            members: members.map((m) => ({
              ...m,
              intent_name: m.intent_name.trim(),
              intent_description: m.intent_description.trim(),
            })),
          }),
        }
      );
      const membersPayload = await membersRes.json();
      if (!membersRes.ok) throw new Error(membersPayload?.error || 'failed');

      setRouters((prev) =>
        prev.map((r) =>
          r.id === editingRouter.id
            ? {
                ...r,
                min_confidence: confidence,
                sticky,
                fallback_agent_id:
                  fallbackAgentId === NO_FALLBACK ? null : fallbackAgentId,
                members,
              }
            : r
        )
      );
      setEditingRouter(null);
      toast.success(t('toastSaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastUpdateFailed'));
    } finally {
      setSaving(false);
    }
  }

  function channelLabel(channelId: string | null): string {
    if (!channelId) return t('wholeAccount');
    return (
      channels.find((c) => c.id === channelId)?.label ?? t('unknownChannel')
    );
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{t('routersTitle')}</CardTitle>
          <CardDescription>{t('routersDescription')}</CardDescription>
        </div>
        <Button
          size="sm"
          onClick={() => setAddOpen(true)}
          disabled={agents.length === 0}
        >
          <Plus className="size-4" />
          {t('addRouterBtn')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : agents.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">
            {t('noAgentsForRouter')}
          </p>
        ) : routers.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">{t('noRouters')}</p>
        ) : (
          routers.map((router) => (
            <div
              key={router.id}
              className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm font-medium">
                  {router.name}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {channelLabel(router.channel_id)} —{' '}
                  {t('intentsCount', { count: router.members.length })}
                </p>
              </div>
              <Switch
                checked={router.is_active}
                onCheckedChange={() => handleToggleActive(router)}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => openEditor(router)}
              >
                <Settings2 className="size-3.5" />
                {t('editBtn')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleDelete(router)}
                className="text-muted-foreground hover:text-red-600"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))
        )}
      </CardContent>

      {/* Create router */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('addRouterDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('routerNameField')}</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('channelField')}</Label>
              <Select
                value={newChannel}
                onValueChange={(v) => setNewChannel(v ?? WHOLE_ACCOUNT)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={WHOLE_ACCOUNT}>
                    {t('wholeAccount')}
                  </SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t('cancelBtn')}
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="size-3.5 animate-spin" />}
              {t('createBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit router + intents */}
      <Dialog
        open={editingRouter !== null}
        onOpenChange={(open) => !open && setEditingRouter(null)}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingRouter?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t('minConfidenceField')}</Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('fallbackAgentField')}</Label>
                <Select
                  value={fallbackAgentId}
                  onValueChange={(v) => setFallbackAgentId(v ?? NO_FALLBACK)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_FALLBACK}>
                      {t('noFallback')}
                    </SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <p className="text-foreground text-sm font-medium">
                {t('stickyField')}
              </p>
              <Switch checked={sticky} onCheckedChange={setSticky} />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t('intentsLabel')}</Label>
                <Button size="sm" variant="outline" onClick={addMemberRow}>
                  <Plus className="size-3.5" />
                  {t('addIntentBtn')}
                </Button>
              </div>
              {members.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  {t('noIntentsYet')}
                </p>
              )}
              {members.map((member, i) => (
                <div
                  key={i}
                  className="border-border space-y-2 rounded-lg border p-3"
                >
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs">{t('intentAgentField')}</Label>
                      <Select
                        value={member.agent_id}
                        onValueChange={(v) =>
                          updateMember(i, { agent_id: v ?? '' })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {agents.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('intentNameField')}</Label>
                      <Input
                        value={member.intent_name}
                        onChange={(e) =>
                          updateMember(i, { intent_name: e.target.value })
                        }
                        placeholder={t('intentNamePlaceholder')}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">
                      {t('intentDescriptionField')}
                    </Label>
                    <Input
                      value={member.intent_description}
                      onChange={(e) =>
                        updateMember(i, { intent_description: e.target.value })
                      }
                      placeholder={t('intentDescriptionPlaceholder')}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">
                      {t('intentExamplesField')}
                    </Label>
                    <Input
                      value={member.examples.join(', ')}
                      onChange={(e) =>
                        updateMember(i, {
                          examples: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder={t('intentExamplesPlaceholder')}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeMember(i)}
                    className="text-muted-foreground hover:text-red-600"
                  >
                    <Trash2 className="size-3.5" />
                    {t('removeIntentBtn')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingRouter(null)}>
              {t('cancelBtn')}
            </Button>
            <Button onClick={handleSaveEditor} disabled={saving}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {t('saveBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
