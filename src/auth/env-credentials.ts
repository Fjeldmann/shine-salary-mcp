import { SalaryError } from '../errors.js';
import { registerSecret } from '../log.js';
import type { ApiCredentials } from './api-client.js';

/**
 * DEVELOPMENT ONLY. Reads API credentials from environment variables (the
 * untracked `.env`, see `.env.example`). It is off unless
 * `SHINE_SALARY_DEV_ENV_CREDENTIALS=1` is set, and the shipped CLI uses the
 * secure store from milestone 3 instead.
 */
export const DEV_FLAG = 'SHINE_SALARY_DEV_ENV_CREDENTIALS';
export const ENV_NAMES = {
  apiClientID: 'API_CLIENT_ID',
  apiClientSecret: 'API_CLIENT_SECRET',
  apiKey: 'API_KEY',
} as const;

export function devEnvCredentialsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEV_FLAG] === '1';
}

export function readDevEnvCredentials(env: NodeJS.ProcessEnv = process.env): ApiCredentials {
  if (!devEnvCredentialsEnabled(env)) {
    throw new SalaryError('AUTH_REQUIRED', 'No credentials are configured.', {
      hint: `For development, set ${DEV_FLAG}=1 and provide ${Object.values(ENV_NAMES).join(', ')}.`,
    });
  }
  return readEnvCredentials(env);
}

/** Read the credential variables without the dev flag (used by an explicit `login --from-env`). */
export function readEnvCredentials(env: NodeJS.ProcessEnv = process.env): ApiCredentials {
  const creds = {
    apiClientID: env[ENV_NAMES.apiClientID]?.trim() ?? '',
    apiClientSecret: env[ENV_NAMES.apiClientSecret]?.trim() ?? '',
    apiKey: env[ENV_NAMES.apiKey]?.trim() ?? '',
  };
  const missing = (Object.keys(ENV_NAMES) as Array<keyof typeof ENV_NAMES>).filter((k) => !creds[k]);
  if (missing.length > 0) {
    throw new SalaryError('AUTH_REQUIRED', `Missing environment variables: ${missing.map((k) => ENV_NAMES[k]).join(', ')}.`);
  }
  registerSecret(creds.apiClientSecret);
  registerSecret(creds.apiKey);
  return creds;
}
