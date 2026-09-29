'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Loader2, Plus, Trash2, Star, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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

export interface AiAgentSummary {
  id: string;
  name: string;
  provider: 'openai' | 'anthropic' | 'gemini' | 'openrouter';
  model: string;
  isDefault: boolean;
  isActive: boolean;
}

const PROVIDER_LABEL: Record<AiAgentSummary['provider'], string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

/**
 * Extra agents beyond the account's default one (specs/multi-agent-
 * router.md). The default agent keeps its existing full-featured
 * editor at Settings → AI Assistant (fallback chain, embeddings,
 * agenda tools) — this list only manages additional, leaner agents
 * meant to be picked by a router's intents.
 */
export function AiAgentsList({
  onAgentsChanged,
}: {
  /** Fired after any create/delete so a sibling router editor can
   *  refresh its agent picker options. */
  onAgentsChanged?: () => void;
}) {
  const t = useTranslations('Agents.multi');

  const [agents, setAgents] = useState<AiAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [provider, setProvider] =
    useState<AiAgentSummary['provider']>('openai');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/agents');
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setAgents(payload.agents ?? []);
    } catch {
      toast.error(t('toastLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setName('');
    setProvider('openai');
    setModel('');
    setApiKey('');
    setSystemPrompt('');
    setIsActive(true);
    setAutoReplyEnabled(true);
  }

  async function handleCreate() {
    if (!name.trim() || !model.trim() || !apiKey.trim()) {
      toast.error(t('toastFieldsRequired'));
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/ai/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          provider,
          model: model.trim(),
          api_key: apiKey.trim(),
          system_prompt: systemPrompt.trim() || undefined,
          is_active: isActive,
          auto_reply_enabled: autoReplyEnabled,
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setAgents((prev) => [...prev, payload.agent]);
      setAddOpen(false);
      resetForm();
      toast.success(t('toastCreated'));
      onAgentsChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastCreateFailed'));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(agent: AiAgentSummary) {
    if (!window.confirm(t('deleteConfirm', { name: agent.name }))) return;
    setDeletingId(agent.id);
    try {
      const res = await fetch(`/api/ai/agents/${agent.id}`, {
        method: 'DELETE',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || 'failed');
      setAgents((prev) => prev.filter((a) => a.id !== agent.id));
      toast.success(t('toastDeleted'));
      onAgentsChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastDeleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{t('agentsTitle')}</CardTitle>
          <CardDescription>{t('agentsDescription')}</CardDescription>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          {t('addAgentBtn')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : agents.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">{t('noAgents')}</p>
        ) : (
          agents.map((agent) => (
            <div
              key={agent.id}
              className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-foreground flex items-center gap-1.5 truncate text-sm font-medium">
                  {agent.isDefault && (
                    <Star className="size-3.5 shrink-0 fill-current text-amber-500" />
                  )}
                  {agent.name}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {PROVIDER_LABEL[agent.provider]} — {agent.model}
                </p>
              </div>
              {agent.isDefault ? (
                <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
                  {t('defaultBadge')}
                </span>
              ) : (
                <div className="flex shrink-0 items-center gap-1">
                  {!agent.isActive && (
                    <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium">
                      {t('inactiveBadge')}
                    </span>
                  )}
                  <Link
                    href={`/agents/${agent.id}`}
                    className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium"
                  >
                    <Pencil className="size-3.5" />
                    {t('editBtn')}
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={deletingId === agent.id}
                    onClick={() => handleDelete(agent)}
                    className="text-muted-foreground hover:text-red-600"
                  >
                    {deletingId === agent.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('addDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('nameField')}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t('providerField')}</Label>
                <Select
                  value={provider}
                  onValueChange={(v) =>
                    setProvider(v as AiAgentSummary['provider'])
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">
                      {PROVIDER_LABEL.openai}
                    </SelectItem>
                    <SelectItem value="anthropic">
                      {PROVIDER_LABEL.anthropic}
                    </SelectItem>
                    <SelectItem value="gemini">
                      {PROVIDER_LABEL.gemini}
                    </SelectItem>
                    <SelectItem value="openrouter">
                      {PROVIDER_LABEL.openrouter}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('modelField')}</Label>
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('apiKeyField')}</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('systemPromptField')}</Label>
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={3}
                placeholder={t('systemPromptPlaceholder')}
              />
            </div>
            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <p className="text-foreground text-sm font-medium">
                {t('isActiveField')}
              </p>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>
            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <p className="text-foreground text-sm font-medium">
                {t('autoReplyEnabledField')}
              </p>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAddOpen(false);
                resetForm();
              }}
            >
              {t('cancelBtn')}
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="size-3.5 animate-spin" />}
              {t('createBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
