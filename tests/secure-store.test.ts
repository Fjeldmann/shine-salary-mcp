import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DpapiKeyProvider, spawnRunner } from '../src/auth/backends/dpapi.js';
import { EncryptedFileBackend } from '../src/auth/backends/encrypted-file.js';
import { KeyringBackend, type EntryFactory } from '../src/auth/backends/keyring.js';
import { withLock } from '../src/auth/lock.js';
import { configRoot, profileDir } from '../src/auth/paths.js';
import { readPrivateFile, writePrivateFileAtomic } from '../src/auth/secure-fs.js';
import { fakeDpapi, FakeKeyProvider, tempRoot } from './store-helpers.js';

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
}

const windows = process.platform === 'win32';

describe('paths', () => {
  // The expected values are POSIX paths, which path.join can't produce on Windows.
  it.skipIf(windows)('follows platform conventions and rejects unsafe profile names', () => {
    expect(configRoot({ XDG_CONFIG_HOME: '/x' }, 'linux', '/h')).toBe('/x/shine-salary-mcp');
    expect(configRoot({}, 'linux', '/h')).toBe('/h/.config/shine-salary-mcp');
    expect(configRoot({}, 'darwin', '/h')).toBe('/h/Library/Application Support/shine-salary-mcp');
    expect(() => profileDir('/r', '../etc')).toThrow();
    expect(() => profileDir('/r', 'Work')).toThrow();
    expect(profileDir('/r', 'work-2')).toBe('/r/profiles/work-2');
  });
});

describe('secure files', () => {
  it('writes 0600 files in 0700 directories and reads them back', async () => {
    const root = await tempRoot();
    const file = join(root, 'a', 'secret.json');
    await writePrivateFileAtomic(file, 'hello');
    if (!windows) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'a'))).mode & 0o777).toBe(0o700);
    }
    expect(await readPrivateFile(file)).toBe('hello');
    expect(await readPrivateFile(join(root, 'a', 'missing'))).toBeUndefined();
  });

  // Creating a symlink on Windows needs elevation or developer mode.
  it.skipIf(windows)('refuses symlinks on read and write', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'target'), 'x', { mode: 0o600 });
    await symlink(join(root, 'target'), join(root, 'link'));
    expect(await codeOf(readPrivateFile(join(root, 'link')))).toBe('STORE_CORRUPT');
    expect(await codeOf(writePrivateFileAtomic(join(root, 'link'), 'y'))).toBe('STORE_CORRUPT');
    expect(await readFile(join(root, 'target'), 'utf8')).toBe('x');
  });

  it('refuses group/world-readable and oversized files', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'open'), 'x', { mode: 0o644 });
    await chmod(join(root, 'open'), 0o644);
    expect(await codeOf(readPrivateFile(join(root, 'open')))).toBe(windows ? 'no error' : 'STORE_CORRUPT');
    await writeFile(join(root, 'big'), 'x'.repeat(100), { mode: 0o600 });
    expect(await codeOf(readPrivateFile(join(root, 'big'), 10))).toBe('STORE_CORRUPT');
  });

  it('replaces atomically: a leftover temp file from a crash does not affect the target', async () => {
    const root = await tempRoot();
    const file = join(root, 'state.json');
    await writePrivateFileAtomic(file, 'v1');
    await writeFile(join(root, '.state.json.dead.tmp'), 'half', { mode: 0o600 });
    expect(await readPrivateFile(file)).toBe('v1');
    await writePrivateFileAtomic(file, 'v2');
    expect(await readPrivateFile(file)).toBe('v2');
    expect((await readdir(root)).filter((f) => f.endsWith('.tmp') && !f.includes('dead'))).toEqual([]);
  });
});

describe('EncryptedFileBackend', () => {
  async function setup() {
    const dir = await tempRoot();
    const keys = new FakeKeyProvider();
    const b = new EncryptedFileBackend('wsl-dpapi', dir, 'default', keys);
    await b.prepare();
    return { dir, keys, b };
  }

  it('round-trips without writing plaintext', async () => {
    const { dir, b } = await setup();
    await b.set('credentials', 'top-secret-value');
    expect(await b.get('credentials')).toBe('top-secret-value');
    expect(await readFile(join(dir, 'credentials.enc'), 'utf8')).not.toContain('top-secret');
    expect(await b.get('token')).toBeUndefined();
  });

  it('fails closed on a flipped ciphertext byte, truncation, or a file moved to another name', async () => {
    const { dir, b } = await setup();
    await b.set('credentials', 'top-secret-value');
    const file = join(dir, 'credentials.enc');
    const env = JSON.parse(await readFile(file, 'utf8')) as { ct: string };
    const ct = Buffer.from(env.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 1;
    await writeFile(file, JSON.stringify({ ...env, ct: ct.toString('base64') }), { mode: 0o600 });
    expect(await codeOf(b.get('credentials'))).toBe('STORE_CORRUPT');

    await b.set('credentials', 'top-secret-value');
    const good = await readFile(file, 'utf8');
    await writeFile(join(dir, 'token.enc'), good, { mode: 0o600 });
    expect(await codeOf(b.get('token'))).toBe('STORE_CORRUPT');

    await writeFile(file, good.slice(0, 20), { mode: 0o600 });
    expect(await codeOf(b.get('credentials'))).toBe('STORE_CORRUPT');
    // Fail closed means the damaged file is left for inspection, not deleted.
    expect(await readFile(file, 'utf8')).toBe(good.slice(0, 20));
  });

  it('does not decrypt under another profile or after the key is replaced', async () => {
    const { dir, keys, b } = await setup();
    await b.set('credentials', 'v');
    const other = new EncryptedFileBackend('wsl-dpapi', dir, 'other', keys);
    expect(await codeOf(other.get('credentials'))).toBe('STORE_CORRUPT');
    await keys.create();
    expect(await codeOf(b.get('credentials'))).toBe('STORE_CORRUPT');
  });

  it('destroy removes secrets and the key', async () => {
    const { dir, keys, b } = await setup();
    await b.set('credentials', 'v');
    await b.set('token', 't');
    await b.destroy();
    expect(await readdir(dir)).toEqual([]);
    expect(keys.key).toBeUndefined();
  });
});

describe('DpapiKeyProvider', () => {
  it('creates a wrapped key, never stores the raw key, and unwraps it in a new instance', async () => {
    const dir = await tempRoot();
    const a = new DpapiKeyProvider(dir, fakeDpapi);
    await a.create();
    const { key, kid } = await a.getKey();
    const file = await readFile(join(dir, 'wrapping-key.dpapi'), 'utf8');
    expect(file).not.toContain(key.toString('base64'));
    const b = new DpapiKeyProvider(dir, fakeDpapi);
    expect((await b.getKey()).key.equals(key)).toBe(true);
    expect((await b.getKey()).kid).toBe(kid);
  });

  it('reports AUTH_REQUIRED when no key exists and STORE_CORRUPT when damaged', async () => {
    const dir = await tempRoot();
    expect(await codeOf(new DpapiKeyProvider(dir, fakeDpapi).getKey())).toBe('AUTH_REQUIRED');
    await writeFile(join(dir, 'wrapping-key.dpapi'), '{"v":2}', { mode: 0o600 });
    expect(await codeOf(new DpapiKeyProvider(dir, fakeDpapi).getKey())).toBe('STORE_CORRUPT');
  });

  it('probe fails cleanly when the helper is broken', async () => {
    expect(await DpapiKeyProvider.probe(async () => {
      throw new Error('no powershell');
    })).toBe(false);
    expect(await DpapiKeyProvider.probe(fakeDpapi)).toBe(true);
  });

  it('talks to the helper over stdin/stdout only (stub executable)', async () => {
    const dir = await tempRoot();
    const stub = join(dir, 'stub.mjs');
    // Mimics powershell: reads "<mode> <b64>", echoes argv count to stderr, answers with BOM + CRLF.
    await writeFile(
      stub,
      `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const [m,b]=s.trim().split(' ');` +
        `const buf=Buffer.from(b,'base64');const out=m==='protect'?Buffer.concat([Buffer.from('dp'),buf]):buf.subarray(2);` +
        `process.stderr.write(String(process.argv.length));process.stdout.write('\\uFEFF'+out.toString('base64')+'\\r\\n');});`,
    );
    const run = spawnRunner(process.execPath, [stub]);
    const secret = Buffer.from('raw-key-material').toString('base64');
    const wrapped = await run('protect', secret);
    expect(await run('unprotect', wrapped)).toBe(secret);
    const failing = spawnRunner(process.execPath, ['-e', 'process.exit(3)']);
    expect(await codeOf(failing('protect', secret))).toBe('STORE_UNAVAILABLE');
    const missing = spawnRunner('/nonexistent/powershell.exe', []);
    expect(await codeOf(missing('protect', secret))).toBe('STORE_UNAVAILABLE');
  });
});

describe('KeyringBackend', () => {
  function fakeKeyring(fail = false): { factory: EntryFactory; data: Map<string, string> } {
    const data = new Map<string, string>();
    const factory: EntryFactory = (service, account) => ({
      async setPassword(p) {
        if (fail) throw new Error('DBus error: org.freedesktop.secrets not provided');
        data.set(`${service}:${account}`, p);
      },
      async getPassword() {
        if (fail) throw new Error('DBus error');
        return data.get(`${service}:${account}`) ?? null;
      },
      async deletePassword() {
        if (!data.delete(`${service}:${account}`)) throw new Error('No matching entry found in secure storage');
      },
    });
    return { factory, data };
  }

  it('stores per profile and deletes idempotently', async () => {
    const { factory, data } = fakeKeyring();
    const b = new KeyringBackend('default', factory);
    await b.set('credentials', 'c');
    expect([...data.keys()]).toEqual(['shine-salary-mcp:default/credentials']);
    expect(await b.get('credentials')).toBe('c');
    expect(await b.get('token')).toBeUndefined();
    await b.destroy();
    await b.destroy();
    expect(data.size).toBe(0);
  });

  it('probe is a real round trip and reports an unavailable Secret Service', async () => {
    expect(await KeyringBackend.probe(fakeKeyring().factory)).toBe(true);
    expect(await KeyringBackend.probe(fakeKeyring(true).factory)).toBe(false);
    expect(await codeOf(new KeyringBackend('default', fakeKeyring(true).factory).set('token', 'x'))).toBe('STORE_UNAVAILABLE');
  });
});

describe('withLock', () => {
  it('serialises holders', async () => {
    const file = join(await tempRoot(), 'p.lock');
    const order: string[] = [];
    const task = (name: string) =>
      withLock(file, async () => {
        order.push(`${name}+`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`${name}-`);
      }, { pollMs: 2 });
    await Promise.all([task('a'), task('b'), task('c')]);
    for (let i = 0; i < order.length; i += 2) expect(order[i]!.slice(0, 1)).toBe(order[i + 1]!.slice(0, 1));
  });

  it('recovers a lock left by a dead process and by an old one', async () => {
    const dir = await tempRoot();
    const file = join(dir, 'p.lock');
    const { hostname } = await import('node:os');
    await writeFile(file, JSON.stringify({ pid: 999_999, host: hostname(), at: Date.now(), nonce: 'n1' }), { mode: 0o600 });
    expect(await withLock(file, async () => 'ok', { isAlive: () => false, waitMs: 500 })).toBe('ok');
    await writeFile(file, JSON.stringify({ pid: process.pid, host: 'elsewhere', at: Date.now() - 10_000, nonce: 'n2' }), { mode: 0o600 });
    expect(await withLock(file, async () => 'ok', { staleMs: 5_000, waitMs: 500 })).toBe('ok');
  });

  it('times out on a live holder and leaves its lock alone', async () => {
    const dir = await tempRoot();
    const file = join(dir, 'p.lock');
    const live = JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), at: Date.now(), nonce: 'live' });
    await writeFile(file, live, { mode: 0o600 });
    expect(await codeOf(withLock(file, async () => 'x', { waitMs: 50, pollMs: 5 }))).toBe('LOCK_TIMEOUT');
    expect(await readFile(file, 'utf8')).toBe(live);
  });

  it('releases on error', async () => {
    const dir = await tempRoot();
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'p.lock');
    await expect(withLock(file, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await withLock(file, async () => 'again', { waitMs: 50 })).toBe('again');
  });
});
