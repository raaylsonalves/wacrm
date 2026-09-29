'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ModelPicker } from '@/components/agents/model-picker';
import {
  HandoffKeywordsField,
  keywordsToList,
} from '@/components/agents/handoff-keywords-field';
import { TranscriptionModelField } from '@/components/agents/transcription-model-field';
import { AgentChannels } from '@/components/agents/agent-channels';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import type { AiProvider } from '@/lib/ai/types';
import type { AccountMember } from '@/types';

const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'openrouter', label: 'OpenRouter' },
];

const HANDOFF_QUEUE = '__queue__';

interface AgentRow {
  id: string;
  name: string;
  provider: AiProvider;
  model: string;
  system_prompt: string | null;
  is_active: boolean;
  auto_reply_enabled: boolean;
  auto_reply_max_per_conversation: number;
  handoff_agent_id: string | null;
  handoff_keywords: string[] | null;
  transcription_model: string | null;
  has_key: boolean;
}

interface AgentUsage {
  calls: number;
  tokens: number;
  lastAt: string | null;
}

/** ~4 characters per token: only an order-of-magnitude hint for prompt size. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * The page a non-default agent was missing (specs/ai-agents-management.md
 * §2): until now an extra agent could be created and deleted but never
 * edited from the UI, so it stayed frozen at whatever prompt it was
 * created with. Edits go through the existing PATCH route.
 */
export function AgentDetail({ agentId }: { agentId: string }) {
  const t = useTranslations('Agents.detail');
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state, seeded from the loaded agent.
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [autoReply, setAutoReply] = useState(true);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [maxReplies, setMaxReplies] = useState(3);
  const [handoffTo, setHandoffTo] = useState('');
  const [keywords, setKeywords] = useState('');
  const [transcriptionModel, setTranscriptionModel] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/ai/agents/${agentId}`, { cache: 'no-store' });
        if (res.status === 404) {
          if (alive) setNotFound(true);
          return;
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'failed');
        if (!alive) return;
        const a = data.agent as AgentRow;
        setAgent(a);
        setName(a.name);
        setPrompt(a.system_prompt ?? '');
        setIsActive(a.is_active);
        setAutoReply(a.auto_reply_enabled);
        setProvider(a.provider);
        setModel(a.model);
        setMaxReplies(a.auto_reply_max_per_conversation);
        setHandoffTo(a.handoff_agent_id ?? '');
        setKeywords((a.handoff_keywords ?? []).join('\n'));
        setTranscriptionModel(a.transcription_model ?? '');
      } catch {
        if (alive) toast.error(t('loadFailed'));
      }
    })();
    void fetchAccountMembers().then((m) => alive && setMembers(m));
    return () => {
      alive = false;
    };
  }, [agentId, t]);

  // Per-agent usage — admin-only by design (spend is billing-class), which
  // is also who can edit; other roles simply don't get the card.
  useEffect(() => {
    if (!canEdit) return;
    let alive = true;
    fetch(`/api/ai/usage?days=30&agent_id=${agentId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        const row = (d.by_agent ?? []).find(
          (a: { agent_id: string | null }) => a.agent_id === agentId,
        );
        setUsage({
          calls: d.totals?.calls ?? 0,
          tokens: d.totals?.total_tokens ?? 0,
          lastAt: row?.last_at ?? null,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId, canEdit]);

  async function save() {
    if (!agent) return;
    if (!name.trim()) {
      toast.error(t('nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        system_prompt: prompt,
        is_active: isActive,
        auto_reply_enabled: autoReply,
        auto_reply_max_per_conversation: maxReplies,
        handoff_agent_id: handoffTo || null,
        handoff_keywords: keywordsToList(keywords),
        transcription_model: transcriptionModel || null,
      };
      // Changing provider/model/key makes the server re-validate against
      // the provider (a round trip), so only send it when it changed.
      if (provider !== agent.provider || model.trim() !== agent.model || apiKey.trim()) {
        body.provider = provider;
        body.model = model.trim();
        if (apiKey.trim()) body.api_key = apiKey.trim();
      }
      const res = await fetch(`/api/ai/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'failed');
      setAgent({
        ...agent,
        name: name.trim(),
        provider,
        model: model.trim(),
        has_key: agent.has_key || !!apiKey.trim(),
      });
      setApiKey('');
      toast.success(t('saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (notFound) {
    return (
      <div className="space-y-3">
        <BackLink label={t('back')} />
        <p className="text-muted-foreground text-sm">{t('notFound')}</p>
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    );
  }

  const disabled = !canEdit || saving;
  const incomplete = !agent.has_key || !agent.model;

  return (
    <div className="space-y-6">
      <div>
        <BackLink label={t('back')} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            {agent.name}
          </h1>
          <StatusBadge
            label={
              incomplete
                ? t('statusIncomplete')
                : agent.is_active && agent.auto_reply_enabled
                  ? t('statusActive')
                  : t('statusPaused')
            }
            tone={
              incomplete ? 'warn' : agent.is_active && agent.auto_reply_enabled ? 'ok' : 'muted'
            }
          />
        </div>
        {!canEdit && (
          <p className="text-muted-foreground mt-1 text-sm">{t('readOnly')}</p>
        )}
      </div>

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle>{t('configTitle')}</CardTitle>
          <CardDescription>{t('configDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="agent-name">{t('name')}</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={disabled}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ToggleRow
              label={t('active')}
              hint={t('activeHint')}
              checked={isActive}
              onChange={setIsActive}
              disabled={disabled}
            />
            <ToggleRow
              label={t('autoReply')}
              hint={t('autoReplyHint')}
              checked={autoReply}
              onChange={setAutoReply}
              disabled={disabled}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="agent-prompt">{t('prompt')}</Label>
              <span className="text-muted-foreground text-xs">
                {t('tokens', { count: estimateTokens(prompt) })}
              </span>
            </div>
            <Textarea
              id="agent-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={10}
              disabled={disabled}
              placeholder={t('promptPlaceholder')}
            />
            <p className="text-muted-foreground text-xs">{t('promptHint')}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('provider')}</Label>
              <Select
                value={provider}
                onValueChange={(v) => {
                  setProvider(v as AiProvider);
                  setModel('');
                }}
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue>
                    {(v: string) => PROVIDERS.find((p) => p.id === v)?.label ?? v}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-key">{t('apiKey')}</Label>
              <Input
                id="agent-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={disabled}
                placeholder={agent.has_key ? t('keyKeep') : t('keyRequired')}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t('model')}</Label>
            <ModelPicker
              provider={provider}
              apiKey={apiKey}
              agentId={agentId}
              value={model}
              onChange={setModel}
              disabled={disabled}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-max">{t('maxReplies')}</Label>
              <Input
                id="agent-max"
                type="number"
                min={1}
                max={20}
                value={maxReplies}
                onChange={(e) =>
                  setMaxReplies(Math.min(20, Math.max(1, Number(e.target.value) || 1)))
                }
                disabled={disabled}
                className="w-24"
              />
              <p className="text-muted-foreground text-xs">{t('maxRepliesHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('handoffTo')}</Label>
              <Select
                value={handoffTo || HANDOFF_QUEUE}
                onValueChange={(v) => setHandoffTo(!v || v === HANDOFF_QUEUE ? '' : v)}
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue>
                    {(v: string) => {
                      if (v === HANDOFF_QUEUE) return t('handoffQueue');
                      const m = members.find((x) => x.user_id === v);
                      return m ? memberLabel(m) : v;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={HANDOFF_QUEUE}>{t('handoffQueue')}</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t('keywords.title')}</Label>
            <p className="text-muted-foreground text-xs">{t('keywords.description')}</p>
            <HandoffKeywordsField value={keywords} onChange={setKeywords} disabled={disabled} />
          </div>

          <div className="space-y-1.5">
            <Label>{t('transcription.title')}</Label>
            <p className="text-muted-foreground text-xs">{t('transcription.description')}</p>
            <TranscriptionModelField
              value={transcriptionModel}
              onChange={setTranscriptionModel}
              disabled={disabled}
            />
          </div>

          {canEdit && (
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {t('save')}
            </Button>
          )}
        </CardContent>
      </Card>

      <AgentChannels agentId={agentId} canEdit={canEdit} />

      {canEdit && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle>{t('usage.title')}</CardTitle>
            <CardDescription>{t('usage.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            {usage === null ? (
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            ) : usage.calls === 0 ? (
              <p className="text-muted-foreground text-sm">{t('usage.none')}</p>
            ) : (
              <dl className="grid grid-cols-3 gap-4 text-sm">
                <Stat label={t('usage.calls')} value={usage.calls.toLocaleString()} />
                <Stat label={t('usage.tokens')} value={usage.tokens.toLocaleString()} />
                <Stat
                  label={t('usage.last')}
                  value={usage.lastAt ? new Date(usage.lastAt).toLocaleString() : '—'}
                />
              </dl>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/agents"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </Link>
  );
}

function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: 'ok' | 'warn' | 'muted';
}) {
  const cls =
    tone === 'ok'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : tone === 'warn'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'bg-muted text-muted-foreground';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="border-border flex items-start justify-between gap-4 rounded-md border p-3">
      <div>
        <p className="text-foreground text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground font-medium">{value}</dd>
    </div>
  );
}
