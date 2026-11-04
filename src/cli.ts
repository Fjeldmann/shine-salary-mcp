#!/usr/bin/env node
import { Command } from 'commander';
import { ApiCredentialTokenProvider } from './auth/api-client.js';
import { devEnvCredentialsEnabled, readDevEnvCredentials } from './auth/env-credentials.js';
import { checkAccess } from './commands/check-access.js';
import { isSalaryError, SalaryError } from './errors.js';
import { redact } from './log.js';
import { serve } from './server.js';
import { NAME, VERSION } from './version.js';

/** Terminal output for interactive commands. `serve` never writes here. */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(err: unknown): never {
  if (isSalaryError(err)) {
    process.stderr.write(`Error [${err.code}]: ${err.message}\n${err.hint ? `Next step: ${err.hint}\n` : ''}`);
  } else {
    const e = err as Error | undefined;
    process.stderr.write(`Unexpected error: ${e?.name ?? 'Error'}: ${redact(String(e?.message ?? err))}\n`);
  }
  process.exit(1);
}

const program = new Command()
  .name(NAME)
  .version(VERSION)
  .description('Local, read-only MCP server for Shine Salary.');

program
  .command('serve')
  .description('Run the MCP server over stdio (used by MCP clients).')
  .action(() => {
    serve();
  });

program
  .command('status')
  .description('Show how credentials are configured. --check also verifies them against Salary (GET only).')
  .option('--check', 'log in and confirm companies and API key scopes')
  .action(async (opts: { check?: boolean }) => {
    try {
      if (!devEnvCredentialsEnabled()) {
        out('Credentials: not configured (secure-store login arrives in milestone 3).');
        out('Development: set SHINE_SALARY_DEV_ENV_CREDENTIALS=1 and load .env.');
        return;
      }
      const creds = readDevEnvCredentials();
      out('Credentials: development environment variables (not for production use).');
      if (!opts.check) return;
      const report = await checkAccess(new ApiCredentialTokenProvider(creds));
      for (const c of report.companies) out(`Company: ${c.name} (${c.id})`);
      for (const k of report.keys) {
        out(`API key "${k.description ?? ''}": scopes ${k.scopes.join(', ') || '(none)'}${k.verifiedReadOnly ? ' (read-only)' : ' (NOT verified read-only: check the key in Salary)'}`);
      }
      out(report.readOnly ? 'Read-only: confirmed from the key\'s scopes.' : 'Read-only: NOT confirmed.');
      if (!report.readOnly) process.exitCode = 3;
    } catch (err) {
      fail(err);
    }
  });

for (const name of ['login', 'logout'] as const) {
  program
    .command(name)
    .description(`${name === 'login' ? 'Store' : 'Delete'} credentials (milestone 3).`)
    .action(() => fail(new SalaryError('NOT_IMPLEMENTED', `\`${name}\` is not implemented yet.`)));
}

await program.parseAsync(process.argv);
