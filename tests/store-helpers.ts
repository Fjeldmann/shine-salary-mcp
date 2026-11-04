import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DpapiRunner } from '../src/auth/backends/dpapi.js';
import { EncryptedFileBackend, type KeyProvider } from '../src/auth/backends/encrypted-file.js';
import type { BackendKind, SecretBackend, SecretName } from '../src/auth/backends/types.js';
import { ProfileStore } from '../src/auth/store.js';

export const tempRoot = () => mkdtemp(join(tmpdir(), 'ssm-test-'));

export class MemoryBackend implements SecretBackend {
  readonly kind: BackendKind = 'keyring';
  readonly data = new Map<string, string>();
  reads = 0;
  async get(name: SecretName) {
    this.reads += 1;
    return this.data.get(name);
  }
  async set(name: SecretName, value: string) {
    this.data.set(name, value);
  }
  async delete(name: SecretName) {
    this.data.delete(name);
  }
  async destroy() {
    this.data.clear();
  }
}

export class FakeKeyProvider implements KeyProvider {
  key: { kid: string; key: Buffer } | undefined;
  async getKey() {
    if (!this.key) throw Object.assign(new Error('no key'), { code: 'AUTH_REQUIRED' });
    return this.key;
  }
  async create() {
    this.key = { kid: randomUUID(), key: randomBytes(32) };
  }
  async destroy() {
    this.key = undefined;
  }
}

/** Reversible stand-in for DPAPI: prefixes the bytes with "dp". */
export const fakeDpapi: DpapiRunner = async (mode, b64) => {
  const buf = Buffer.from(b64, 'base64');
  if (mode === 'protect') return Buffer.concat([Buffer.from('dp'), buf]).toString('base64');
  if (buf.subarray(0, 2).toString() !== 'dp') throw new Error('bad blob');
  return buf.subarray(2).toString('base64');
};

/** A store whose backends live in memory / temp files, shared across instances like a real profile. */
export function testStoreFactory(root: string) {
  const memory = new MemoryBackend();
  const keys = new FakeKeyProvider();
  const make = () =>
    new ProfileStore('default', root, {
      backendFactory: (kind, store) => (kind === 'keyring' ? memory : new EncryptedFileBackend('wsl-dpapi', store.dir, store.profile, keys)),
      lock: { waitMs: 5_000, pollMs: 5 },
    });
  return { make, memory, keys };
}
