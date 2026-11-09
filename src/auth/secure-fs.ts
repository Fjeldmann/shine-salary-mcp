import { constants, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { SalaryError } from '../errors.js';

/**
 * Owner-only file handling for local auth state: directories 0700, files
 * 0600, no symlinks, ownership checked, bounded reads, atomic replacement.
 *
 * Mode bits only exist on POSIX. Node reports every writable file on Windows
 * as 0666, whatever its ACL says, so the check would refuse every file there.
 * On Windows the profile sits in the user-only %APPDATA% and secrets go to the
 * Credential Manager (keyring backend), so these files hold nothing secret.
 * WSL reports as linux and keeps the check.
 */

const ENFORCE_MODES = process.platform !== 'win32';
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : undefined);

function unsafe(path: string, why: string): SalaryError {
  return new SalaryError('STORE_CORRUPT', `Refusing to use ${basename(path)}: ${why}.`, {
    hint: `Inspect ${dirname(path)}; run \`shine-salary-mcp logout\` and log in again if in doubt.`,
  });
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw unsafe(dir, 'not a real directory');
  const me = uid();
  if (me !== undefined && st.uid !== me) throw unsafe(dir, 'owned by another user');
  if (ENFORCE_MODES && (st.mode & 0o077) !== 0) await fs.chmod(dir, 0o700);
}

/** Read a private file. Returns undefined if it does not exist. */
export async function readPrivateFile(path: string, maxBytes = 64 * 1024): Promise<string | undefined> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw unsafe(path, 'it is a symbolic link');
    throw err;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw unsafe(path, 'not a regular file');
    const me = uid();
    if (me !== undefined && st.uid !== me) throw unsafe(path, 'owned by another user');
    if (ENFORCE_MODES && (st.mode & 0o077) !== 0) throw unsafe(path, 'readable by other users');
    if (st.size > maxBytes) throw unsafe(path, 'too large');
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Write via a temporary file in the same directory, fsync, then rename over the target. */
export async function writePrivateFileAtomic(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await ensurePrivateDir(dir);
  try {
    const st = await fs.lstat(path);
    if (st.isSymbolicLink() || !st.isFile()) throw unsafe(path, 'not a regular file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } catch (err) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  try {
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  const dh = await fs.open(dir, constants.O_RDONLY);
  try {
    await dh.sync();
  } catch {
    // Some filesystems do not support fsync on directories.
  } finally {
    await dh.close();
  }
}

export async function removeFile(path: string): Promise<void> {
  await fs.rm(path, { force: true });
}
