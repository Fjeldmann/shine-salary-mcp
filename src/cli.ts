#!/usr/bin/env node
import { Command, Option } from 'commander';
import { ApiCredentialTokenProvider, type ApiCredentials } from './auth/api-client.js';
import { BACKEND_KINDS } from './auth/backends/types.js';
import { devEnvCredentialsEnabled, ENV_NAMES, readDevEnvCredentials, readEnvCredentials } from './auth/env-credentials.js';
import { DEFAULT_PROFILE } from './auth/paths.js';
import { ProfileStore } from './auth/store.js';
import { checkStored, login, logout, status, type BackendChoice } from './commands/auth-commands.js';
import { checkAccess, type AccessReport } from './commands/check-access.js';
import { ask } from './commands/prompt.js';
import { isSalaryError } from './errors.js';
import { redact } from './log.js';
import { serve } from './server.js';
import { NAME, VERSION } from './version.js';

/** Terminal output for interactive commands. `serve` never writes here. */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(err: unknown): never {
  if (isSalaryError(err)) {
    process.stderr.write(`Error [${err.code}]: ${redact(err.message)}\n${err.hint ? `Next step: ${err.hint}\n` : ''}`);
  } else {
    const e = err as Error | undefined;
    process.stderr.write(`Unexpected error: ${e?.name ?? 'Error'}: ${redact(String(e?.message ?? err))}\n`);
  }
  process.exit(1);
}

function printAccess(report: AccessReport): void {
  for (const c of report.companies) out(`Company: ${c.name} (${c.id})`);
  for (const k of report.keys) {
    out(`API key "${k.description ?? ''}": scopes ${k.scopes.join(', ') || '(none)'}${k.verifiedReadOnly ? ' (read-only)' : ' (NOT verified read-only)'}`);
  }
  out(report.readOnly ? "Read-only: confirmed from the key's scopes." : 'Read-only: NOT confirmed.');
}

const program = new Command()
  .name(NAME)
  .version(VERSION)
  .description('Local, read-only MCP server for Shine Salary.')
  .option('--profile <name>', 'credential profile', DEFAULT_PROFILE);

const store = () => new ProfileStore(program.opts<{ profile: string }>().profile);

program
  .command('serve')
  .description('Run the MCP server over stdio (used by MCP clients). Never prompts or opens a browser.')
  .action(() => {
    serve(store());
  });

program
  .command('login')
  .description('Verify Salary API credentials and store them in a secure local store.')
  .addOption(new Option('--method <method>', 'authentication method').choices(['api']).default('api'))
  .addOption(new Option('--backend <backend>', 'credential store').choices(['auto', ...BACKEND_KINDS]).default('auto'))
  .option('--from-env', `read ${Object.values(ENV_NAMES).join(', ')} from the environment instead of prompting (development)`)
  .action(async (opts: { backend: BackendChoice; fromEnv?: boolean }) => {
    try {
      let creds: ApiCredentials;
      if (opts.fromEnv) {
        creds = readEnvCredentials();
      } else {
        process.stderr.write('Enter the API client details from Salary and the company API key. Secrets are not echoed.\n');
        creds = {
          apiClientID: await ask('API client ID: '),
          apiClientSecret: await ask('API client secret: ', { hidden: true }),
          apiKey: await ask('Company API key: ', { hidden: true }),
        };
      }
      const { state, report } = await login(store(), creds, { backend: opts.backend });
      printAccess(report);
      out(`Stored in: ${state.backend} (profile "${state.profile}").`);
      out('Logged in. MCP clients can now run `shine-salary-mcp serve`.');
    } catch (err) {
      fail(err);
    }
  });

program
  .command('logout')
  .description('Delete the stored credentials, token and keys for this profile.')
  .action(async () => {
    try {
      const had = await logout(store());
      out(had ? 'Logged out: local credentials, token and keys deleted.' : 'Nothing was stored for this profile.');
      out('This does not revoke anything at Salary. To revoke access, delete the company API key in Salary.');
    } catch (err) {
      fail(err);
    }
  });

program
  .command('status')
  .description('Show how credentials are stored. --check also verifies them against Salary (GET only).')
  .option('--check', 'log in and confirm companies and API key scopes')
  .action(async (opts: { check?: boolean }) => {
    try {
      const s = store();
      const st = await status(s);
      if (!st.configured || !st.state) {
        out(`Profile "${s.profile}": not logged in.`);
        if (devEnvCredentialsEnabled()) {
          out('Development environment credentials are enabled.');
          if (opts.check) {
            const report = await checkAccess(new ApiCredentialTokenProvider(readDevEnvCredentials()));
            printAccess(report);
            if (!report.readOnly) process.exitCode = 3;
          }
        } else {
          out('Run `shine-salary-mcp login`.');
          process.exitCode = 2;
        }
        return;
      }
      const { state } = st;
      out(`Profile "${state.profile}": logged in (API client), store ${state.backend}.`);
      out(`Company: ${state.companyName} (${state.companyID}); scopes at login: ${state.scopes.join(', ')}.`);
      out(`Credentials readable: ${st.credentialsReadable ? 'yes' : `no${st.storeError ? ` (${st.storeError})` : ''}`}.`);
      if (st.tokenExpiresAt !== undefined) {
        const mins = Math.round((st.tokenExpiresAt - Date.now()) / 60_000);
        out(mins > 0 ? `Access token: estimated ${mins} min left; renewed automatically.` : 'Access token: expired; renewed automatically on next use.');
      }
      if (opts.check) {
        const report = await checkStored(s);
        printAccess(report);
        if (!report.readOnly) process.exitCode = 3;
      } else if (!st.credentialsReadable) {
        process.exitCode = 1;
      }
    } catch (err) {
      fail(err);
    }
  });

await program.parseAsync(process.argv);
