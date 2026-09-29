'use client';

import { useParams } from 'next/navigation';
import { AgentDetail } from '@/components/agents/agent-detail';

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  return <AgentDetail agentId={params.id} />;
}
