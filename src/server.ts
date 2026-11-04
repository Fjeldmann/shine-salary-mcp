import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
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

export function serve(): StdioServerHandle {
  log('info', 'serve: starting stdio server');
  return serveStdio(() => createServer(), {
    onerror: (err) => log('error', 'serve: transport error', { name: err.name }),
  });
}
