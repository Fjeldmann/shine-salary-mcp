import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { SalaryError } from '../errors.js';
import { DpapiKeyProvider, type DpapiRunner, powershellRunner } from './backends/dpapi.js';
import { EncryptedFileBackend } from './backends/encrypted-file.js';
import { defaultEntryFactory, KeyringBackend, type EntryFactory } from './backends/keyring.js';
import { BACKEND_KINDS, type BackendKind, type SecretBackend } from './backends/types.js';
import { withLock, type LockOptions } from './lock.js';
import { configRoot, DEFAULT_PROFILE, isWsl, profileDir } from './paths.js';
import { readPrivateFile, removeFile, writePrivateFileAtomic } from './secure-fs.js';

/** Non-secret profile state. Every token request reads it, which is how logout reaches running processes. */
export const ProfileState = z.object({
  version: z.literal(1),
  profile: z.string(),
  backend: z.enum(BACKEND_KINDS as [BackendKind, ...BackendKind[]]),
  generation: z.uuid(),
  companyID: z.guid(),
  companyName: z.string().max(500),
  scopes: z.array(z.string().max(100)).max(50),
  createdAt: z.string(),
});
export type ProfileState = z.infer<typeof ProfileState>;

export const CredentialsRecord = z.object({
  v: z.literal(1),
  mode: z.literal('api'),
  generation: z.uuid(),
  apiClientID: z.guid(),
  apiClientSecret: z.string().min(1).max(4096),
  apiKey: z.string().min(1).max(4096),
});
export type CredentialsRecord = z.infer<typeof CredentialsRecord>;

export const TokenRecord = z.object({
  v: z.literal(1),
  generation: z.uuid(),
  accessToken: z.string().min(16).max(4096),
  obtainedAt: z.number(),
  expiresAt: z.number(),
});
export type TokenRecord = z.infer<typeof TokenRecord>;

export interface StoreDeps {
  entryFactory?: () => Promise<EntryFactory>;
  dpapiRunner?: () => DpapiRunner;
  /** Replace backends entirely (tests). */
  backendFactory?: (kind: BackendKind, store: ProfileStore) => SecretBackend;
  lock?: LockOptions;
  isWsl?: () => boolean;
}

/** One profile's state file, lock and secret backend. */
export class ProfileStore {
  readonly dir: string;
  readonly profile: string;
  readonly #deps: StoreDeps;
  readonly #backends = new Map<BackendKind, Promise<SecretBackend>>();

  constructor(profile = DEFAULT_PROFILE, root = configRoot(), deps: StoreDeps = {}) {
    this.profile = profile;
    this.dir = profileDir(root, profile);
    this.#deps = deps;
  }

  get stateFile(): string {
    return join(this.dir, 'state.json');
  }

  lock<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(join(this.dir, '..', `${this.profile}.lock`), fn, this.#deps.lock);
  }

  async readState(): Promise<ProfileState | undefined> {
    const raw = await readPrivateFile(this.stateFile, 16 * 1024);
    if (raw === undefined) return undefined;
    try {
      return ProfileState.parse(JSON.parse(raw));
    } catch (err) {
      throw new SalaryError('STORE_CORRUPT', 'The profile state file is damaged.', {
        hint: 'Run `shine-salary-mcp logout`, then log in again.',
        cause: err,
      });
    }
  }

  async writeState(state: Omit<ProfileState, 'version' | 'profile' | 'generation' | 'createdAt'> & { generation?: string }): Promise<ProfileState> {
    const full = ProfileState.parse({
      version: 1,
      profile: this.profile,
      createdAt: new Date().toISOString(),
      ...state,
      generation: state.generation ?? randomUUID(),
    });
    await writePrivateFileAtomic(this.stateFile, JSON.stringify(full, null, 2));
    return full;
  }

  async deleteState(): Promise<void> {
    await removeFile(this.stateFile);
  }

  backend(kind: BackendKind): Promise<SecretBackend> {
    let b = this.#backends.get(kind);
    if (!b) {
      b = this.#createBackend(kind);
      this.#backends.set(kind, b);
      b.catch(() => this.#backends.delete(kind));
    }
    return b;
  }

  async #createBackend(kind: BackendKind): Promise<SecretBackend> {
    if (this.#deps.backendFactory) return this.#deps.backendFactory(kind, this);
    if (kind === 'keyring') {
      return new KeyringBackend(this.profile, await (this.#deps.entryFactory ?? defaultEntryFactory)());
    }
    const run = (this.#deps.dpapiRunner ?? powershellRunner)();
    return new EncryptedFileBackend('wsl-dpapi', this.dir, this.profile, new DpapiKeyProvider(this.dir, run));
  }

  /** Which backends work here, in order of preference. Each is a real round trip. */
  async availableBackends(): Promise<BackendKind[]> {
    const found: BackendKind[] = [];
    if (this.#deps.backendFactory) return [...BACKEND_KINDS];
    try {
      if (await KeyringBackend.probe(await (this.#deps.entryFactory ?? defaultEntryFactory)())) found.push('keyring');
    } catch {
      // module failed to load: not available
    }
    if ((this.#deps.isWsl ?? isWsl)() && (await DpapiKeyProvider.probe((this.#deps.dpapiRunner ?? powershellRunner)()))) {
      found.push('wsl-dpapi');
    }
    return found;
  }
}

export function parseRecord<T extends z.ZodType>(schema: T, raw: string | undefined, what: string): z.infer<T> | undefined {
  if (raw === undefined) return undefined;
  try {
    return schema.parse(JSON.parse(raw));
  } catch (err) {
    throw new SalaryError('STORE_CORRUPT', `The stored ${what} is damaged.`, {
      hint: 'Run `shine-salary-mcp logout`, then log in again.',
      cause: err,
    });
  }
}
