import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { SalaryError } from '../errors.js';
import { ensurePrivateDir } from './secure-fs.js';

/**
 * A per-profile lock file shared by every process (serve instances, login,
 * logout). The holder may be inside a `/v2/auth` exchange (20 s timeout plus
 * retries), so the wait and stale thresholds are well above that.
 */
export interface LockOptions {
  waitMs?: number;
  staleMs?: number;
  pollMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

interface LockInfo {
  pid: number;
  host: string;
  at: number;
  nonce: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(file: string): Promise<LockInfo | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.at === 'number' && typeof parsed.nonce === 'string') {
      return { pid: parsed.pid, at: parsed.at, nonce: parsed.nonce, host: String(parsed.host ?? '') };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  }
  // Unreadable or half-written: treat as stale only once it is old (by mtime).
  try {
    const st = await fs.stat(file);
    return { pid: -1, host: '', at: st.mtimeMs, nonce: '' };
  } catch {
    return undefined;
  }
}

export async function withLock<T>(file: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? 90_000;
  const staleMs = opts.staleMs ?? 180_000;
  const pollMs = opts.pollMs ?? 100;
  const now = opts.now ?? Date.now;
  const isAlive = opts.isAlive ?? pidAlive;
  const me: LockInfo = { pid: process.pid, host: hostname(), at: now(), nonce: randomUUID() };
  const deadline = now() + waitMs;

  await ensurePrivateDir(dirname(file));
  for (;;) {
    try {
      const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await handle.writeFile(JSON.stringify({ ...me, at: now() }));
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const holder = await readLock(file);
    if (holder) {
      const sameHost = holder.host === me.host;
      const dead = holder.pid > 0 && sameHost && !isAlive(holder.pid);
      const old = now() - holder.at > staleMs;
      if (dead || old) {
        // Remove only if it is still the lock we judged stale.
        const again = await readLock(file);
        if (again && again.nonce === holder.nonce && again.at === holder.at) await fs.rm(file, { force: true });
        continue;
      }
    }
    if (now() >= deadline) {
      throw new SalaryError('LOCK_TIMEOUT', 'Another shine-salary-mcp process is holding the credential lock.', {
        hint: 'Wait for it to finish, or stop other shine-salary-mcp processes and retry.',
      });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  try {
    return await fn();
  } finally {
    const current = await readLock(file);
    if (current?.nonce === me.nonce) await fs.rm(file, { force: true });
  }
}
