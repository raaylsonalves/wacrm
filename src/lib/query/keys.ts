/**
 * Query keys in one place, so a write knows exactly which cached reads to
 * refresh. Every key starts with the account: switching accounts (operator
 * mode) can never serve another account's cache.
 */
export const qk = {
  pipelines: (accountId: string) => ['pipelines', accountId] as const,
  stages: (accountId: string, pipelineId: string) =>
    ['pipeline-stages', accountId, pipelineId] as const,
  deals: (accountId: string, pipelineId: string) =>
    ['deals', accountId, pipelineId] as const,
};
