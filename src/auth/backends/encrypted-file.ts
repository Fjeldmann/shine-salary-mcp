import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { SalaryError } from '../../errors.js';
import { readPrivateFile, removeFile, writePrivateFileAtomic } from '../secure-fs.js';
import type { BackendKind, SecretBackend, SecretName } from './types.js';

export interface KeyProvider {
  getKey(): Promise<{ kid: string; key: Buffer }>;
  create(): Promise<void>;
  destroy(): Promise<void>;
}

const Envelope = z.object({
  v: z.literal(1),
  alg: z.literal('A256GCM'),
  kid: z.string().min(1).max(64),
  nonce: z.base64(),
  tag: z.base64(),
  ct: z.base64(),
});

/**
 * AES-256-GCM files, one per secret. The associated data binds the envelope
 * version, profile, secret name and key id, so a file copied to another name
 * or profile does not decrypt.
 */
export class EncryptedFileBackend implements SecretBackend {
  readonly kind: BackendKind;
  readonly #dir: string;
  readonly #profile: string;
  readonly #keys: KeyProvider;

  constructor(kind: BackendKind, dir: string, profile: string, keys: KeyProvider) {
    this.kind = kind;
    this.#dir = dir;
    this.#profile = profile;
    this.#keys = keys;
  }

  #file(name: SecretName): string {
    return join(this.#dir, `${name}.enc`);
  }

  #aad(name: SecretName, kid: string): Buffer {
    return Buffer.from(`shine-salary-mcp|1|${this.#profile}|${name}|${kid}`, 'utf8');
  }

  async get(name: SecretName): Promise<string | undefined> {
    const raw = await readPrivateFile(this.#file(name));
    if (raw === undefined) return undefined;
    const corrupt = (cause?: unknown) =>
      new SalaryError('STORE_CORRUPT', `Stored ${name} could not be decrypted.`, {
        hint: 'Run `shine-salary-mcp logout`, then log in again.',
        cause,
      });
    let env: z.infer<typeof Envelope>;
    try {
      env = Envelope.parse(JSON.parse(raw));
    } catch (err) {
      throw corrupt(err);
    }
    const { kid, key } = await this.#keys.getKey();
    if (env.kid !== kid) throw corrupt();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
      decipher.setAAD(this.#aad(name, kid));
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
    } catch (err) {
      throw corrupt(err);
    }
  }

  async set(name: SecretName, value: string): Promise<void> {
    const { kid, key } = await this.#keys.getKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(this.#aad(name, kid));
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const envelope = { v: 1, alg: 'A256GCM', kid, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
    await writePrivateFileAtomic(this.#file(name), JSON.stringify(envelope));
  }

  async delete(name: SecretName): Promise<void> {
    await removeFile(this.#file(name));
  }

  /** Called by login before the first write. */
  async prepare(): Promise<void> {
    await this.#keys.create();
  }

  async destroy(): Promise<void> {
    await this.delete('token');
    await this.delete('credentials');
    await this.#keys.destroy();
  }
}
