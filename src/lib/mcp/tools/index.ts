// ============================================================
// Tool registration — decides which tools exist for this process
// based on the write guards. Reads are always on; writes and
// broadcasts are opt-in (see config.ts).
// ============================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import type { WacrmClient } from '../client';
import type { Config } from '../config';
import { registerReadTools } from './read';
import { registerWriteTools } from './write';
import { registerBroadcastTools } from './broadcast';

export function registerTools(server: McpServer, client: WacrmClient, config: Config): string[] {
  const enabled: string[] = ['read'];
  registerReadTools(server, client);

  if (config.enableWrites) {
    registerWriteTools(server, client);
    enabled.push('write');
  }

  if (config.enableBroadcasts) {
    registerBroadcastTools(server, client);
    enabled.push('broadcast');
  }

  return enabled;
}


