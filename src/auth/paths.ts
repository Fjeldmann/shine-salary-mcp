import { existsSync, readFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { SalaryError } from '../errors.js';

export const APP_DIR = 'shine-salary-mcp';
export const DEFAULT_PROFILE = 'default';
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Per-user configuration root, following each platform's convention. */
export function configRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  // Override for tests and unusual setups.
  if (env.SHINE_SALARY_CONFIG_DIR) return resolve(env.SHINE_SALARY_CONFIG_DIR);
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_DIR);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR);
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), APP_DIR);
}

export function validateProfile(profile: string): string {
  if (!PROFILE_RE.test(profile)) {
    throw new SalaryError('INVALID_PARAMS', 'Profile names use lower-case letters, digits, "-" and "_" (max 32).');
  }
  return profile;
}

export function profileDir(root: string, profile: string): string {
  return join(root, 'profiles', validateProfile(profile));
}

/** True inside WSL (1 or 2). */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return true;
  if (/microsoft/i.test(release())) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}
