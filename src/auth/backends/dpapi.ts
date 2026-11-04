import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { SalaryError } from '../../errors.js';
import { readPrivateFile, removeFile, writePrivateFileAtomic } from '../secure-fs.js';
import type { KeyProvider } from './encrypted-file.js';

/**
 * Protects the file-encryption key with Windows DPAPI (CurrentUser) from
 * inside WSL, through powershell.exe. Key material travels over stdin/stdout
 * only, never as arguments. The wrapped key can only be unwrapped by the same
 * Windows user with their profile loaded, so it survives reboots without a
 * passphrase. Not suitable for a Windows service account.
 */

export type DpapiRunner = (mode: 'protect' | 'unprotect', base64: string) => Promise<string>;

const ENTROPY = 'shine-salary-mcp/dpapi/v1';
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  "$parts = [Console]::In.ReadToEnd().Trim().Split(' ')",
  '$data = [Convert]::FromBase64String($parts[1])',
  `$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
  "$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser",
  "if ($parts[0] -eq 'protect') { $out = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope) } elseif ($parts[0] -eq 'unprotect') { $out = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope) } else { throw 'bad mode' }",
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('\n');

const POWERSHELL_CANDIDATES = ['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'powershell.exe'];

export function findPowershell(): string {
  return POWERSHELL_CANDIDATES.find((p) => !p.startsWith('/') || existsSync(p)) ?? 'powershell.exe';
}

/** Run a helper that reads "<mode> <base64>" on stdin and writes base64 on stdout. */
export function spawnRunner(command: string, args: readonly string[], timeoutMs = 20_000): DpapiRunner {
  return (mode, base64) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new SalaryError('STORE_UNAVAILABLE', 'The Windows DPAPI helper did not answer in time.'));
      }, timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d.length + out.length > 1_000_000 ? '' : d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-500)));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new SalaryError('STORE_UNAVAILABLE', 'Could not start the Windows DPAPI helper (powershell.exe).', { cause: e }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const result = out.replace(/^﻿/, '').trim();
        if (code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(result)) {
          // stderr can be logged by the caller's debug path; it holds no key material.
          reject(new SalaryError('STORE_UNAVAILABLE', `The Windows DPAPI helper failed (exit ${String(code)}).`, { cause: new Error(err) }));
          return;
        }
        resolve(result);
      });
      child.stdin.end(`${mode} ${base64}\n`);
    });
}

export function powershellRunner(): DpapiRunner {
  // -EncodedCommand (UTF-16LE base64) avoids any quoting issues across the WSL boundary. It carries no secrets.
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return spawnRunner(findPowershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
}

const WrappedKeyFile = z.object({ v: z.literal(1), kid: z.string().min(8).max(64), blob: z.string().min(16).max(8192) });

export class DpapiKeyProvider implements KeyProvider {
  readonly #file: string;
  readonly #run: DpapiRunner;
  #cached: { kid: string; key: Buffer } | undefined;

  constructor(dir: string, run: DpapiRunner = powershellRunner()) {
    this.#file = join(dir, 'wrapping-key.dpapi');
    this.#run = run;
  }

  async getKey(): Promise<{ kid: string; key: Buffer }> {
    if (this.#cached) return this.#cached;
    const raw = await readPrivateFile(this.#file, 16 * 1024);
    if (raw === undefined) {
      throw new SalaryError('AUTH_REQUIRED', 'No stored credentials.', { hint: 'Run `shine-salary-mcp login`.' });
    }
    let parsed: z.infer<typeof WrappedKeyFile>;
    try {
      parsed = WrappedKeyFile.parse(JSON.parse(raw));
    } catch (err) {
      throw new SalaryError('STORE_CORRUPT', 'The wrapped key file is damaged.', { hint: 'Run `shine-salary-mcp logout`, then log in again.', cause: err });
    }
    const key = Buffer.from(await this.#run('unprotect', parsed.blob), 'base64');
    if (key.length !== 32) throw new SalaryError('STORE_CORRUPT', 'The unwrapped key has the wrong length.');
    this.#cached = { kid: parsed.kid, key };
    return this.#cached;
  }

  /** Create and wrap a fresh key, replacing any existing one. */
  async create(): Promise<void> {
    const key = randomBytes(32);
    const kid = randomUUID();
    const blob = await this.#run('protect', key.toString('base64'));
    // Prove the round trip before relying on it.
    const back = Buffer.from(await this.#run('unprotect', blob), 'base64');
    if (!back.equals(key)) throw new SalaryError('STORE_UNAVAILABLE', 'Windows DPAPI round trip failed.');
    await writePrivateFileAtomic(this.#file, JSON.stringify({ v: 1, kid, blob }));
    this.#cached = { kid, key };
  }

  async destroy(): Promise<void> {
    this.#cached?.key.fill(0);
    this.#cached = undefined;
    await removeFile(this.#file);
  }

  /** Feature test: DPAPI round trip through the helper, without touching any file. */
  static async probe(run: DpapiRunner = powershellRunner()): Promise<boolean> {
    try {
      const sample = randomBytes(16).toString('base64');
      return (await run('unprotect', await run('protect', sample))) === sample;
    } catch {
      return false;
    }
  }
}
