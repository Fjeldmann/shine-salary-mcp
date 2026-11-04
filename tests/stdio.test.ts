import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** Send JSON-RPC lines to `serve`, then close stdin and collect output. */
async function runServe(lines: object[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, 'serve'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // No credentials and no network: serve must start without them.
    env: { PATH: process.env.PATH ?? '', SHINE_SALARY_CONFIG_DIR: join(tmpdir(), `ssm-stdio-${process.pid}`), ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const expected = lines.filter((l) => 'id' in l).length;
  for (const l of lines) child.stdin.write(`${JSON.stringify(l)}\n`);
  const deadline = Date.now() + 5000;
  while (stdout.split('\n').filter(Boolean).length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  return { stdout, stderr };
}

const SIX = [
  'salary_company_overview',
  'salary_find_employees',
  'salary_employee_summary',
  'salary_payroll_overview',
  'salary_payslip_summary',
  'salary_time_summary',
];

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

describe('serve over stdio (built dist/cli.js)', () => {
  it('has a build to test (run `npm test`, which builds first)', () => {
    expect(existsSync(CLI)).toBe(true);
  });

  it('answers a 2026-07-28 discover and tools/list, with only JSON-RPC on stdout', async () => {
    const { stdout, stderr } = await runServe(
      [
        { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: META } },
      ],
      { SHINE_SALARY_LOG_LEVEL: 'debug' },
    );
    const messages = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: Record<string, unknown> });
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
    expect(messages[0]!.result!.supportedVersions).toContain('2026-07-28');
    expect((messages[1]!.result!.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(SIX);
    expect(stderr).toContain('serve: starting');
    expect(stderr).toContain('not logged in');
  });

  it('still serves a 2025-era initialize', async () => {
    const { stdout } = await runServe([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const messages = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: Record<string, unknown> });
    expect(messages[0]!.result!.serverInfo).toMatchObject({ name: 'shine-salary-mcp' });
    expect((messages[1]!.result!.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(SIX);
  });

  it('answers a tool call with AUTH_REQUIRED when not logged in, without touching stdout otherwise', async () => {
    const { stdout } = await runServe([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: META, name: 'salary_company_overview', arguments: {} } },
    ]);
    const [msg] = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { result: { isError: boolean; content: Array<{ text: string }> } });
    expect(msg!.result.isError).toBe(true);
    expect(JSON.parse(msg!.result.content[0]!.text).error.code).toBe('AUTH_REQUIRED');
  });
});
