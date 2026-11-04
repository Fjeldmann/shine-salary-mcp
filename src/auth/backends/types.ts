export type BackendKind = 'keyring' | 'wsl-dpapi';
export const BACKEND_KINDS: readonly BackendKind[] = ['keyring', 'wsl-dpapi'];

/** The two secrets a profile holds. */
export type SecretName = 'credentials' | 'token' | 'browser-state';
export const SECRET_NAMES: readonly SecretName[] = ['token', 'credentials', 'browser-state'];

export interface SecretBackend {
  readonly kind: BackendKind;
  get(name: SecretName): Promise<string | undefined>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
  /** Remove every secret and key this backend holds for the profile. */
  destroy(): Promise<void>;
}
