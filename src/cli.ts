#!/usr/bin/env node
import { Command, Option } from 'commander';
import { ApiCredentialTokenProvider, type ApiCredentials } from './auth/api-client.js';
import { BACKEND_KINDS } from './auth/backends/types.js';
import { devEnvCredentialsEnabled, ENV_NAMES, readDevEnvCredentials, readEnvCredentials } from './auth/env-credentials.js';
import { DEFAULT_PROFILE } from './auth/paths.js';
import { ProfileStore } from './auth/store.js';
import { checkStored, checkStoredCompanies, login, loginBrowser, logout, status, type BackendChoice } from './commands/auth-commands.js';
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
  .description('Verify Salary credentials and store them in a secure local store.')
  .addOption(new Option('--method <method>', 'api = API client + read-only company key (recommended); browser = sign in to app.salary.dk').choices(['api', 'browser']).default('api'))
  .option('--accept-user-session', 'browser method: accept that the stored session has your full Salary permissions')
  .addOption(new Option('--backend <backend>', 'credential store').choices(['auto', ...BACKEND_KINDS]).default('auto'))
  .option('--from-env', `read ${Object.values(ENV_NAMES).join(', ')} from the environment instead of prompting (development)`)
  .action(async (opts: { method: 'api' | 'browser'; backend: BackendChoice; fromEnv?: boolean; acceptUserSession?: boolean }) => {
    try {
      if (opts.method === 'browser') return await browserLoginCommand(opts);
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

const BROWSER_WARNING = [
  'Browser login stores your Salary *web session*. Unlike the API key method, that session has every permission',
  'your Salary user has, including changing payroll. shine-salary-mcp only ever sends GET requests, but the',
  'stored credential itself is not read-only. It lasts until Salary ends the session; renewing it needs you.',
].join('\n');

async function browserLoginCommand(opts: { backend: BackendChoice; acceptUserSession?: boolean }): Promise<void> {
  const s = store();
  process.stderr.write(`${BROWSER_WARNING}\n`);
  const previous = await s.readState().catch(() => undefined);
  if (previous?.mode === 'api') {
    process.stderr.write(`Profile "${s.profile}" is logged in with a read-only API key; this replaces it. Use --profile <name> to keep both.\n`);
  }
  if (!opts.acceptUserSession) {
    const answer = await ask('Type "yes" to continue: ', { nonInteractiveHint: 'Run it in a terminal, or add --accept-user-session.' });
    if (answer.toLowerCase() !== 'yes') {
      out('Cancelled.');
      process.exitCode = 1;
      return;
    }
  }
  process.stderr.write('Opening a browser window. Sign in to Salary there (including MFA). The window closes by itself.\n');
  const { state, companies, rememberedDevice } = await loginBrowser(s, { backend: opts.backend });
  for (const c of companies) out(`Company: ${c.name} (${c.id})`);
  out(`Stored in: ${state.backend} (profile "${state.profile}"), browser session.`);
  if (rememberedDevice) out('Trusted-device state saved for the next browser login.');
  out('Logged in. When the session expires, tools will ask you to run this login again.');
}

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
      const browser = state.mode === 'browser';
      out(`Profile "${state.profile}": logged in (${browser ? 'browser session' : 'API client'}), store ${state.backend}.`);
      for (const c of state.companies ?? (state.companyID ? [{ id: state.companyID, name: state.companyName ?? '' }] : [])) out(`Company: ${c.name} (${c.id})`);
      out(browser ? 'Read-only: enforced by this client only; the session itself has your full Salary permissions.' : `Scopes at login: ${state.scopes.join(', ')}.`);
      if (state.tokenRejectedAfterMs !== undefined) out(`Last browser session was rejected after ${Math.round(state.tokenRejectedAfterMs / 60000)} min.`);
      out(`Credentials readable: ${st.credentialsReadable ? 'yes' : `no${st.storeError ? ` (${st.storeError})` : ''}`}.`);
      if (browser && st.tokenObtainedAt !== undefined) {
        out(`Session token age: ${Math.round((Date.now() - st.tokenObtainedAt) / 60000)} min (used until Salary rejects it).`);
      } else if (st.tokenExpiresAt !== undefined) {
        const mins = Math.round((st.tokenExpiresAt - Date.now()) / 60_000);
        out(mins > 0 ? `Access token: estimated ${mins} min left; renewed automatically.` : 'Access token: expired; renewed automatically on next use.');
      }
      if (opts.check) {
        if (browser) {
          const companies = await checkStoredCompanies(s);
          out(`Session valid: ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} visible.`);
        } else {
          const report = await checkStored(s);
          printAccess(report);
          if (!report.readOnly) process.exitCode = 3;
        }
      } else if (!st.credentialsReadable) {
        process.exitCode = 1;
      }
    } catch (err) {
      fail(err);
    }
  });

await program.parseAsync(process.argv);
