import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { ProfileStore } from './auth/store.js';
import { log } from './log.js';
import { NAME, VERSION } from './version.js';

/**
 * Builds one MCP server instance. Tools are registered here in a fixed order
 * (milestone 4); none are exposed yet, so the boundary can be tested first.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Read-only access to Shine Salary payroll data for one company. No tools are available yet in this build.',
    },
  );
  return server;
}

export function serve(store?: ProfileStore): StdioServerHandle {
  log('info', 'serve: starting stdio server');
  // Tools arrive in milestone 4; for now only report whether login has happened.
  store
    ?.readState()
    .then((s) => log(s ? 'info' : 'warn', s ? 'serve: credentials configured' : 'serve: not logged in; run `shine-salary-mcp login`', s ? { backend: s.backend } : {}))
    .catch((e: unknown) => log('warn', 'serve: credential state unreadable', { code: (e as { code?: string }).code ?? 'unknown' }));
  return serveStdio(() => createServer(), {
    onerror: (err) => log('error', 'serve: transport error', { name: err.name }),
  });
}
