import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';

export const DEFAULT_TEMP_STORAGE_DIR = path.resolve(
  os.tmpdir(),
  'downlyx-media-tmp'
);

export const DEFAULT_MAX_TOTAL_TEMP_BYTES = 250 * 1024 * 1024; // 250 MB disk quota

function sanitizeJobSegment(jobId: string): string {
  const cleaned = jobId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('Invalid job directory identifier.');
  }
  return cleaned;
}

export function ensureTempStorageDir(baseDir = DEFAULT_TEMP_STORAGE_DIR): string {
  const resolved = path.resolve(baseDir);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Temporary storage root must be a non-symlink directory.');
    }
    fs.chmodSync(resolved, 0o700);
  } else {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    fs.chmodSync(resolved, 0o700);
  }
  return fs.realpathSync(resolved);
}

export function assertConfinedTempPath(
  targetPath: string,
  baseDir = DEFAULT_TEMP_STORAGE_DIR
): string {
  const realBase = ensureTempStorageDir(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  if (
    resolvedTarget !== realBase &&
    !resolvedTarget.startsWith(`${realBase}${path.sep}`)
  ) {
    // Also compare against path.resolve(baseDir) in case baseDir parent had a system symlink (e.g. /tmp -> /private/tmp)
    const logicalBase = path.resolve(baseDir);
    if (
      resolvedTarget !== logicalBase &&
      !resolvedTarget.startsWith(`${logicalBase}${path.sep}`)
    ) {
      throw new Error('Path traversal rejected: path escapes temporary storage boundary.');
    }
  }

  // Validate existing path segments do not traverse through symlinks
  if (fs.existsSync(resolvedTarget)) {
    const lstat = fs.lstatSync(resolvedTarget);
    if (lstat.isSymbolicLink()) {
      throw new Error('Symlink rejected inside temporary storage.');
    }
    const realTarget = fs.realpathSync(resolvedTarget);
    if (
      realTarget !== realBase &&
      !realTarget.startsWith(`${realBase}${path.sep}`)
    ) {
      throw new Error('Symlink escape rejected outside temporary storage.');
    }
    return realTarget;
  }

  const parentDir = path.dirname(resolvedTarget);
  if (fs.existsSync(parentDir)) {
    const parentLstat = fs.lstatSync(parentDir);
    if (parentLstat.isSymbolicLink() || !parentLstat.isDirectory()) {
      throw new Error('Symlink parent directory rejected inside temporary storage.');
    }
    const realParent = fs.realpathSync(parentDir);
    if (
      realParent !== realBase &&
      !realParent.startsWith(`${realBase}${path.sep}`)
    ) {
      throw new Error('Path escapes confined temporary storage directory.');
    }
    return path.join(realParent, path.basename(resolvedTarget));
  }

  return resolvedTarget;
}

export function ensureJobTempSubdir(
  jobId: string,
  baseDir = DEFAULT_TEMP_STORAGE_DIR
): string {
  const realBase = ensureTempStorageDir(baseDir);
  const safeId = sanitizeJobSegment(jobId);
  const jobDir = path.join(realBase, safeId);

  if (fs.existsSync(jobDir)) {
    const lstat = fs.lstatSync(jobDir);
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
      throw new Error('Job scratch path must not be a symlink.');
    }
    fs.chmodSync(jobDir, 0o700);
  } else {
    fs.mkdirSync(jobDir, { mode: 0o700 });
    fs.chmodSync(jobDir, 0o700);
  }

  return assertConfinedTempPath(jobDir, realBase);
}

export function createRandomizedTempPath(
  extension: string,
  baseDir = DEFAULT_TEMP_STORAGE_DIR,
  jobId?: string
): { fileId: string; filePath: string } {
  const realBase = ensureTempStorageDir(baseDir);
  const targetDir = jobId ? ensureJobTempSubdir(jobId, realBase) : realBase;
  const safeExt = extension.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const fileId = crypto.randomBytes(24).toString('hex');
  const candidate = path.join(targetDir, `${fileId}.${safeExt}`);
  const filePath = assertConfinedTempPath(candidate, realBase);
  return { fileId, filePath };
}

export async function safeRemoveFile(
  filePath: string | undefined | null,
  baseDir = DEFAULT_TEMP_STORAGE_DIR
): Promise<boolean> {
  if (!filePath) return false;
  try {
    const confined = assertConfinedTempPath(filePath, baseDir);
    await fsPromises.unlink(confined);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return false;
    return false;
  }
}

export async function removeJobTempDir(
  jobId: string,
  baseDir = DEFAULT_TEMP_STORAGE_DIR
): Promise<boolean> {
  try {
    const realBase = ensureTempStorageDir(baseDir);
    const safeId = sanitizeJobSegment(jobId);
    const jobDir = path.join(realBase, safeId);
    if (!fs.existsSync(jobDir)) return false;
    const confined = assertConfinedTempPath(jobDir, realBase);
    await fsPromises.rm(confined, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function getTempDirUsageBytes(
  baseDir = DEFAULT_TEMP_STORAGE_DIR
): Promise<number> {
  const realBase = ensureTempStorageDir(baseDir);
  let total = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fsPromises.lstat(full);
          if (!stat.isSymbolicLink()) total += stat.size;
        } catch {
          // ignore race
        }
      }
    }
  }

  try {
    await walk(realBase);
  } catch {
    // ignore read failure
  }
  return total;
}

export async function sweepExpiredTempFiles(params: {
  baseDir?: string;
  maxAgeMs: number;
  activeFilePaths?: ReadonlySet<string>;
  activeJobIds?: ReadonlySet<string>;
}): Promise<number> {
  const realBase = ensureTempStorageDir(params.baseDir ?? DEFAULT_TEMP_STORAGE_DIR);
  const now = Date.now();
  let removedCount = 0;

  try {
    const entries = await fsPromises.readdir(realBase, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        try {
          await fsPromises.unlink(path.join(realBase, entry.name));
          removedCount += 1;
        } catch {
          // ignore
        }
        continue;
      }

      const fullPath = assertConfinedTempPath(path.join(realBase, entry.name), realBase);

      if (entry.isDirectory()) {
        if (params.activeJobIds?.has(entry.name)) continue;
        try {
          const dirStat = await fsPromises.lstat(fullPath);
          const dirFiles = await fsPromises.readdir(fullPath);
          const hasActiveFile = dirFiles.some((f) =>
            params.activeFilePaths?.has(path.join(fullPath, f))
          );
          if (hasActiveFile) continue;

          if (dirFiles.length === 0 || now - dirStat.mtimeMs >= params.maxAgeMs) {
            await fsPromises.rm(fullPath, { recursive: true, force: true });
            removedCount += 1;
          }
        } catch {
          // ignore
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (params.activeFilePaths?.has(fullPath)) continue;

      try {
        const stat = await fsPromises.lstat(fullPath);
        if (now - stat.mtimeMs >= params.maxAgeMs) {
          await fsPromises.unlink(fullPath);
          removedCount += 1;
        }
      } catch {
        // Ignore transient race if file was already removed
      }
    }
  } catch {
    // Ignore directory read error
  }

  return removedCount;
}
