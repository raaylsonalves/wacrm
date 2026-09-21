/**
 * Stateless MCP Streamable HTTP endpoint.
 *
 * Every request creates a fresh MCP server and transport. This is important
 * on Vercel because function invocations are not sticky and cannot safely
 * keep MCP sessions in process memory. Clients send the WACRM API key as a
 * bearer token; MCP_API_KEY is supported only as a private-server fallback.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { WacrmClient } from '@/lib/mcp/client';
import { registerTools } from '@/lib/mcp/tools/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SERVER_VERSION = '0.2.0';

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function jsonError(status: number, message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32000, message }, id: null },
    { status },
  );
}

function addCors(request: Request, response: Response): Response {
  const origin = request.headers.get('origin');
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
  }
  return response;
}

function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;

  const configured = process.env.MCP_ALLOWED_ORIGINS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!configured?.length) return origin === new URL(request.url).origin;
  return configured.includes(origin);
}

function getApiKey(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim() || undefined;
  }
  return process.env.MCP_API_KEY?.trim() || undefined;
}

function createServer(request: Request): McpServer {
  const apiKey = getApiKey(request);
  if (!apiKey) throw new Error('Missing Authorization: Bearer <WACRM_API_KEY>');

  const baseUrl = (
    process.env.WACRM_BASE_URL?.trim() || new URL(request.url).origin
  ).replace(/\/+$/, '');
  const enableWrites = truthy(
    process.env.MCP_ENABLE_WRITES ?? process.env.WACRM_ENABLE_WRITES,
  );
  const enableBroadcasts = truthy(
    process.env.MCP_ENABLE_BROADCASTS ?? process.env.WACRM_ENABLE_BROADCASTS,
  );

  if (enableBroadcasts && !enableWrites) {
    throw new Error('MCP_ENABLE_BROADCASTS requires MCP_ENABLE_WRITES');
  }

  const server = new McpServer({ name: 'wacrm-mcp-remote', version: SERVER_VERSION });
  // The standalone package has its own SDK installation. The runtime API is
  // identical, but TypeScript sees the two private SDK declarations as
  // distinct types when both package trees are present.
  registerTools(server as unknown as Parameters<typeof registerTools>[0], new WacrmClient({ baseUrl, apiKey }), {
    baseUrl,
    apiKey,
    enableWrites,
    enableBroadcasts,
  });
  return server;
}

async function handleMcp(request: Request): Promise<Response> {
  if (!allowedOrigin(request)) return jsonError(403, 'Invalid Origin');

  const server = createServer(request);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    keepAliveMs: 15_000,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    response.headers.set('Cache-Control', 'no-cache, no-transform');
    response.headers.set('X-Accel-Buffering', 'no');
    return addCors(request, response);
  } catch (error) {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    console.error('[mcp] request failed:', error);
    return addCors(request, jsonError(500, 'MCP request failed'));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleMcp(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP request failed';
    return addCors(
      request,
      jsonError(message.startsWith('Missing Authorization') ? 401 : 500, message),
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!allowedOrigin(request)) return jsonError(403, 'Invalid Origin');
  return jsonError(405, 'Use POST for MCP Streamable HTTP');
}

export async function DELETE(request: Request): Promise<Response> {
  if (!allowedOrigin(request)) return jsonError(403, 'Invalid Origin');
  return jsonError(405, 'This stateless MCP endpoint has no sessions to delete');
}

export async function OPTIONS(request: Request): Promise<Response> {
  if (!allowedOrigin(request)) return jsonError(403, 'Invalid Origin');
  const origin = request.headers.get('origin') ?? new URL(request.url).origin;
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      Vary: 'Origin',
    },
  });
}
