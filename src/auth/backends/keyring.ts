import { SalaryError } from '../../errors.js';
import type { SecretBackend, SecretName } from './types.js';

export const KEYRING_SERVICE = 'shine-salary-mcp';

/** The subset of @napi-rs/keyring's AsyncEntry this backend uses. */
export interface KeyringEntry {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | null | undefined>;
  deletePassword(): Promise<boolean | void>;
}
export type EntryFactory = (service: string, account: string) => KeyringEntry;

/**
 * On Linux the Secret Service is required. @napi-rs/keyring otherwise falls
 * back to the kernel keyutils store, which works across processes but is lost
 * on reboot (observed on WSL2, 2026-11-04) — the opposite of what login promises.
 */
export async function defaultEntryFactory(): Promise<EntryFactory> {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  return (service, account) => new AsyncEntry(service, account, { linux: { store: 'secret-service' } });
}

function unavailable(err: unknown): SalaryError {
  return new SalaryError('STORE_UNAVAILABLE', 'The OS keychain is not available.', {
    hint: 'On Linux this needs a running Secret Service (e.g. gnome-keyring). On WSL use --backend wsl-dpapi.',
    cause: err,
  });
}

export class KeyringBackend implements SecretBackend {
  readonly kind = 'keyring' as const;
  readonly #profile: string;
  readonly #factory: EntryFactory;

  constructor(profile: string, factory: EntryFactory) {
    this.#profile = profile;
    this.#factory = factory;
  }

  #entry(name: string): KeyringEntry {
    return this.#factory(KEYRING_SERVICE, `${this.#profile}/${name}`);
  }

  async get(name: SecretName): Promise<string | undefined> {
    try {
      return (await this.#entry(name).getPassword()) ?? undefined;
    } catch (err) {
      if (/no (matching )?entry|not.?found/i.test(String((err as Error)?.message))) return undefined;
      throw unavailable(err);
    }
  }

  async set(name: SecretName, value: string): Promise<void> {
    try {
      await this.#entry(name).setPassword(value);
    } catch (err) {
      throw unavailable(err);
    }
  }

  async delete(name: SecretName): Promise<void> {
    try {
      await this.#entry(name).deletePassword();
    } catch (err) {
      if (/no (matching )?entry|not.?found/i.test(String((err as Error)?.message))) return;
      throw unavailable(err);
    }
  }

  async destroy(): Promise<void> {
    await this.delete('token');
    await this.delete('credentials');
  }

  /** Feature test: a real write, read-back and delete, not just "the module loaded". */
  static async probe(factory: EntryFactory): Promise<boolean> {
    const entry = factory(KEYRING_SERVICE, `probe/${process.pid}`);
    const value = `probe-${Date.now()}`;
    try {
      await entry.setPassword(value);
      const back = await entry.getPassword();
      await entry.deletePassword();
      return back === value;
    } catch {
      return false;
    }
  }
}
