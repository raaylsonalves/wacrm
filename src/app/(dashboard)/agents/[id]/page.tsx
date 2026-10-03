'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { AgentChannels } from '@/components/agents/agent-channels';
import { AiConfig } from '@/components/settings/ai-config';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { SkeletonPage } from '@/components/ui/skeleton';

/**
 * One page per agent, the same form for all of them: model, prompt,
 * agenda, fallback provider, cases, voice, handoff, numbers. Only the
 * account-wide parts (embeddings key, knowledge base) stay on the default
 * agent — they used to make it a different screen altogether, and the
 * other agents had no agenda or fallback options.
 */
export default function AgentPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations('Agents.detail');
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const [kind, setKind] = useState<'loading' | 'default' | 'extra'>('loading');

  useEffect(() => {
    let alive = true;
    fetch('/api/ai/agents', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        const a = (d?.agents ?? []).find((x: { id: string }) => x.id === params.id);
        setKind(a?.isDefault ? 'default' : 'extra');
      })
      .catch(() => alive && setKind('extra'));
    return () => {
      alive = false;
    };
  }, [params.id]);

  if (kind === 'loading') {
    return (
<SkeletonPage variant="cards" />
    );
  }
  return (
    <div className="space-y-6">
      <Link
        href="/agents"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-3.5" />
        {t('back')}
      </Link>
      <AgentChannels agentId={params.id} canEdit={canEdit} />
      <AiConfig
        hideHeader
        showName
        agentId={kind === 'extra' ? params.id : undefined}
      />
    </div>
  );
}
