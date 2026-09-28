'use client';

import { useCallback, useEffect, useState } from 'react';
import { AiAgentsList, type AiAgentSummary } from './ai-agents-list';
import { AiRouters } from './ai-routers';

/**
 * Multi-agent + intent router (specs/multi-agent-router.md). Fetches
 * the agent list once here so the router editor's agent pickers stay
 * in sync with adds/deletes in the agents list above it, without a
 * second round-trip on every router open.
 */
export function AiMultiAgent() {
  const [agents, setAgents] = useState<AiAgentSummary[]>([]);

  const refreshAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/agents');
      const payload = await res.json();
      if (res.ok) setAgents(payload.agents ?? []);
    } catch {
      // AiAgentsList already surfaces its own load-failure toast.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAgents();
  }, [refreshAgents]);

  return (
    <div className="space-y-6">
      <AiAgentsList onAgentsChanged={refreshAgents} />
      <AiRouters agents={agents} />
    </div>
  );
}
