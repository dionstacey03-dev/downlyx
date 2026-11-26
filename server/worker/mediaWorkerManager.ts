import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import type { DownloadJob, MediaTypeLabel, PlatformId } from '../../src/types/media.ts';
import {
  createSignedDownloadToken,
  verifySignedDownloadToken,
} from '../security/sessionAuth.ts';
import {
  DEFAULT_MAX_TOTAL_TEMP_BYTES,
  DEFAULT_TEMP_STORAGE_DIR,
  assertConfinedTempPath,
  ensureJobTempSubdir,
  ensureTempStorageDir,
  getTempDirUsageBytes,
  removeJobTempDir,
  sweepExpiredTempFiles,
} from '../storage/tempStorage.ts';
import { DEFAULT_MAX_MEDIA_DURATION_SECONDS } from './ffmpegProcessor.ts';
import {
  executeWorkerJob,
  type WorkerEvent,
  type WorkerJobInput,
} from './workerProcess.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_SCRIPT_PATH = path.resolve(__dirname, 'workerProcess.ts');

const WORKER_VAS_LIMIT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB V8 address space cap
const WORKER_CPU_LIMIT_SECONDS = 90;

const HAS_PRLIMIT = (() => {
  try {
    const res = spawnSync('prlimit', ['--version'], {
      shell: false,
      stdio: 'ignore',
    });
    return res.status === 0;
  } catch {
    return false;
  }
})();

export const MAX_AUTO_RETRIES = 3;

export type CustomWorkerExecutor = (
  input: WorkerJobInput,
  onEvent: (ev: WorkerEvent) => void,
  signal: AbortSignal
) => Promise<void>;

interface InternalJobRecord {
  job: DownloadJob;
  ownerId: string;
  workerInput: WorkerJobInput;
  fileId?: string;
  filePath?: string;
  cancelFn?: () => void;
  retryTimer?: NodeJS.Timeout;
  cancelled?: boolean;
}

export class MediaWorkerManager {
  private jobs = new Map<string, InternalJobRecord>();
  private tempDir: string;
  private fileTtlMs: number;
  private maxConcurrentPerOwner: number;
  private maxBytes: number;
  private maxTotalStorageBytes: number;
  private maxDurationSeconds: number;
  private timeoutMs: number;
  private retryDelayMs: number;
  private customExecutor?: CustomWorkerExecutor;
  private sweeperTimer?: NodeJS.Timeout;

  constructor(options?: {
    tempDir?: string;
    fileTtlMs?: number;
    maxConcurrentPerOwner?: number;
    maxBytes?: number;
    maxTotalStorageBytes?: number;
    maxDurationSeconds?: number;
    timeoutMs?: number;
    retryDelayMs?: number;
    customExecutor?: CustomWorkerExecutor;
    disableAutoSweeper?: boolean;
  }) {
    this.tempDir = ensureTempStorageDir(
      options?.tempDir ?? DEFAULT_TEMP_STORAGE_DIR
    );
    this.fileTtlMs = options?.fileTtlMs ?? 5 * 60 * 1000;
    this.maxConcurrentPerOwner = options?.maxConcurrentPerOwner ?? 3;
    this.maxBytes = options?.maxBytes ?? 50 * 1024 * 1024;
    this.maxTotalStorageBytes =
      options?.maxTotalStorageBytes ?? DEFAULT_MAX_TOTAL_TEMP_BYTES;
    this.maxDurationSeconds =
      options?.maxDurationSeconds ?? DEFAULT_MAX_MEDIA_DURATION_SECONDS;
    this.timeoutMs = options?.timeoutMs ?? 90_000;
    this.retryDelayMs = options?.retryDelayMs ?? 600;
    this.customExecutor = options?.customExecutor;

    if (!options?.disableAutoSweeper) {
      this.sweeperTimer = setInterval(() => {
        void this.cleanupExpiredFiles();
      }, 30_000);
      this.sweeperTimer.unref();
    }
  }

  public getWorkerIsolationSummary() {
    return {
      processIsolation: true,
      osResourceLimitsEnforced: HAS_PRLIMIT,
      osNetworkNamespaceEnforced: false,
      containerDeploymentRequiredForNetNs: true,
      tempDirPermissions: '0700',
    };
  }

  public async cleanupExpiredFiles(): Promise<number> {
    const now = Date.now();
    const activePaths = new Set<string>();
    const activeJobIds = new Set<string>();

    for (const record of this.jobs.values()) {
      const status = record.job.status;
      if (status === 'queued' || status === 'processing' || status === 'verifying') {
        activeJobIds.add(record.job.id);
        if (record.filePath) activePaths.add(record.filePath);
        continue;
      }

      if (record.job.expiresAt && now > Date.parse(record.job.expiresAt)) {
        await removeJobTempDir(record.job.id, this.tempDir);
        record.filePath = undefined;
        record.fileId = undefined;
        record.job.downloadUrl = undefined;
        record.job.downloadToken = undefined;
      } else if (record.filePath) {
        activeJobIds.add(record.job.id);
        activePaths.add(record.filePath);
      }
    }

    return sweepExpiredTempFiles({
      baseDir: this.tempDir,
      maxAgeMs: this.fileTtlMs,
      activeFilePaths: activePaths,
      activeJobIds,
    });
  }

  public async startDownloadJob(params: {
    ownerId: string;
    url: string;
    platform: PlatformId;
    platformName: string;
    mediaType: MediaTypeLabel;
    targetFormat: string;
    autoRetry?: boolean;
  }): Promise<
    { ok: true; job: DownloadJob } | { ok: false; status: number; error: string }
  > {
    let activeForOwner = 0;
    for (const record of this.jobs.values()) {
      if (
        record.ownerId === params.ownerId &&
        (record.job.status === 'queued' ||
          record.job.status === 'processing' ||
          record.job.status === 'verifying')
      ) {
        activeForOwner += 1;
      }
    }

    if (activeForOwner >= this.maxConcurrentPerOwner) {
      return {
        ok: false,
        status: 429,
        error: `Maximum of ${this.maxConcurrentPerOwner} concurrent download jobs reached.`,
      };
    }

    const nowIso = new Date().toISOString();
    const jobId = crypto.randomUUID();
    const maxRetries = params.autoRetry ? MAX_AUTO_RETRIES : 0;
    const job: DownloadJob = {
      id: jobId,
      url: params.url,
      platform: params.platform,
      platformName: params.platformName,
      mediaType: params.mediaType,
      targetFormat: params.targetFormat.toUpperCase(),
      status: 'queued',
      progressPercent: 0,
      bytesDownloaded: 0,
      totalBytes: null,
      stageMessage: 'Queued for isolated media worker...',
      retryCount: 0,
      maxRetries,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const workerInput: WorkerJobInput = {
      jobId,
      url: params.url,
      targetFormat: params.targetFormat,
      maxBytes: this.maxBytes,
      maxDurationSeconds: this.maxDurationSeconds,
      timeoutMs: this.timeoutMs,
      tempDir: this.tempDir,
    };

    const record: InternalJobRecord = {
      job,
      ownerId: params.ownerId,
      workerInput,
    };
    // Reserve slot synchronously before any async I/O to eliminate TOCTOU concurrency bypasses
    this.jobs.set(jobId, record);

    // Reclaim expired files before checking global temporary storage quota
    await this.cleanupExpiredFiles();
    const currentUsage = await getTempDirUsageBytes(this.tempDir);
    // Reserve output capacity for active jobs. Downloaded input bytes are
    // included in currentUsage as they land on disk.
    const activeReservations = Array.from(this.jobs.entries()).reduce((total, [id, active]) => {
      if (id === jobId) return total;
      const status = active.job.status;
      if (status !== 'queued' && status !== 'processing' && status !== 'verifying') return total;
      return total + (active.workerInput.maxBytes ?? this.maxBytes);
    }, 0);
    const requestedReservation = workerInput.maxBytes ?? this.maxBytes;
    if (currentUsage + activeReservations + requestedReservation > this.maxTotalStorageBytes) {
      this.jobs.delete(jobId);
      return {
        ok: false,
        status: 507,
        error: 'Temporary media storage quota is full. Retry after active files expire or are removed.',
      };
    }

    this.dispatchWorker(record);

    return { ok: true, job: { ...job } };
  }

  private dispatchWorker(record: InternalJobRecord) {
    if (record.cancelled || record.job.status === 'cancelled') return;
    if (this.customExecutor) {
      this.runWithCustomExecutor(record, record.workerInput);
    } else {
      this.spawnIsolatedChildWorker(record, record.workerInput);
    }
  }

  private handleWorkerEvent(record: InternalJobRecord, ev: WorkerEvent) {
    if (record.cancelled || record.job.status === 'cancelled') return;

    if (ev.type === 'progress') {
      record.job.status = ev.status;
      record.job.bytesDownloaded = ev.bytesDownloaded;
      record.job.totalBytes = ev.totalBytes;
      record.job.progressPercent = ev.progressPercent;
      record.job.stageMessage = ev.stageMessage;
      record.job.updatedAt = new Date().toISOString();
      return;
    }

    if (ev.type === 'completed') {
      record.fileId = ev.fileId;
      record.filePath = assertConfinedTempPath(ev.filePath, this.tempDir);
      const signed = createSignedDownloadToken({
        jobId: record.job.id,
        ownerId: record.ownerId,
        fileId: ev.fileId,
        ttlMs: this.fileTtlMs,
      });

      record.job.status = 'completed';
      record.job.progressPercent = 100;
      record.job.bytesDownloaded = ev.verifiedMetadata.sizeBytes;
      record.job.totalBytes = ev.verifiedMetadata.sizeBytes;
      record.job.verifiedMetadata = ev.verifiedMetadata;
      record.job.error = undefined;
      // Token is NOT placed in downloadUrl query string (sent in X-Download-Token header only)
      record.job.downloadUrl = `/api/downloads/${encodeURIComponent(
        record.job.id
      )}/file`;
      record.job.downloadToken = signed.token;
      record.job.expiresAt = signed.expiresAt;
      record.job.stageMessage = 'Verified and ready for download.';
      record.job.updatedAt = new Date().toISOString();
      record.cancelFn = undefined;
      return;
    }

    if (ev.type === 'failed') {
      record.cancelFn = undefined;
      void removeJobTempDir(record.job.id, this.tempDir);

      const currentRetries = record.job.retryCount ?? 0;
      const maxRetries = record.job.maxRetries ?? 0;

      if (currentRetries < maxRetries) {
        const nextRetry = currentRetries + 1;
        record.job.retryCount = nextRetry;
        record.job.status = 'queued';
        record.job.progressPercent = 0;
        record.job.bytesDownloaded = 0;
        record.job.totalBytes = null;
        record.job.downloadUrl = undefined;
        record.job.downloadToken = undefined;
        record.job.error = ev.error;
        record.job.stageMessage = `Attempt failed — auto-retrying (${nextRetry}/${maxRetries})...`;
        record.job.updatedAt = new Date().toISOString();

        if (record.retryTimer) {
          clearTimeout(record.retryTimer);
        }
        record.retryTimer = setTimeout(() => {
          record.retryTimer = undefined;
          if (record.cancelled || record.job.status !== 'queued') return;
          record.job.stageMessage = `Retrying download (attempt ${nextRetry} of ${maxRetries})...`;
          record.job.updatedAt = new Date().toISOString();
          this.dispatchWorker(record);
        }, this.retryDelayMs);
        record.retryTimer.unref();
        return;
      }

      record.job.status = maxRetries > 0 ? 'permanently_failed' : 'failed';
      record.job.error = ev.error;
      record.job.downloadUrl = undefined;
      record.job.downloadToken = undefined;
      record.job.stageMessage =
        maxRetries > 0
          ? `Download permanently failed after ${maxRetries} retry attempts.`
          : 'Download failed.';
      record.job.updatedAt = new Date().toISOString();
    }
  }

  private runWithCustomExecutor(
    record: InternalJobRecord,
    input: WorkerJobInput
  ) {
    const controller = new AbortController();
    record.cancelFn = () => controller.abort();

    void (this.customExecutor ?? executeWorkerJob)(
      input,
      (ev) => this.handleWorkerEvent(record, ev),
      controller.signal
    ).catch((err) => {
      if (record.job.status !== 'cancelled') {
        this.handleWorkerEvent(record, {
          type: 'failed',
          error: err instanceof Error ? err.message : 'Worker execution failed.',
        });
      }
    });
  }

  private spawnIsolatedChildWorker(
    record: InternalJobRecord,
    input: WorkerJobInput
  ) {
    const jobDir = ensureJobTempSubdir(record.job.id, this.tempDir);

    // Sanitized worker env: strips all app/API/session secrets
    const workerEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: jobDir,
      LANG: 'C.UTF-8',
      DOWNLYX_WORKER_MODE: '1',
    };

    // The production image runs the API under Bun. Bun's CLI needs the
    // explicit "run" subcommand and does not use Node's V8 heap flag.
    // Keep the Node invocation for local Node-based deployments.
    const nodeArgs = process.versions.bun
      ? ['run', WORKER_SCRIPT_PATH]
      : ['--max-old-space-size=256', WORKER_SCRIPT_PATH];
    const spawnCmd = HAS_PRLIMIT ? 'prlimit' : process.execPath;
    const spawnArgs = HAS_PRLIMIT
      ? [
          `--as=${WORKER_VAS_LIMIT_BYTES}`,
          `--cpu=${WORKER_CPU_LIMIT_SECONDS}`,
          `--fsize=${this.maxBytes + 1024 * 1024}`,
          '--',
          process.execPath,
          ...nodeArgs,
        ]
      : nodeArgs;

    const child = spawn(spawnCmd, spawnArgs, {
      shell: false,
      cwd: jobDir,
      env: workerEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const killProcessGroup = () => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
          setTimeout(() => {
            // child.killed only records whether a signal was sent; it does
            // not indicate process exit. Escalate unless the process actually
            // exited so stubborn workers cannot survive cancellation.
            if (child.exitCode === null && child.signalCode === null && child.pid) {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                try {
                  child.kill('SIGKILL');
                } catch {
                  // ignore
                }
              }
            }
          }, 400);
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // ignore
      }
    };

    let finished = false;
    let attemptSettled = false;
    const hardTimeout = setTimeout(() => {
      if (!finished) {
        attemptSettled = true;
        killProcessGroup();
        this.handleWorkerEvent(record, {
          type: 'failed',
          error: 'Isolated media worker timed out.',
        });
      }
    }, this.timeoutMs + 5000);

    record.cancelFn = () => {
      killProcessGroup();
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        const ev = JSON.parse(line) as WorkerEvent;
        if (ev.type === 'completed' || ev.type === 'failed') {
          attemptSettled = true;
        }
        this.handleWorkerEvent(record, ev);
      } catch {
        // Ignore malformed non-JSON lines
      }
    });

    let stderrText = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrText.length < 2048) {
        stderrText += chunk.toString('utf8');
      }
    });

    child.on('error', (err) => {
      finished = true;
      clearTimeout(hardTimeout);
      rl.close();
      if (!attemptSettled) {
        attemptSettled = true;
        this.handleWorkerEvent(record, {
          type: 'failed',
          error: `Worker process error: ${err.message}`,
        });
      }
    });

    child.on('close', (code) => {
      finished = true;
      clearTimeout(hardTimeout);
      rl.close();
      if (
        !attemptSettled &&
        !record.cancelled &&
        record.job.status !== 'completed' &&
        record.job.status !== 'failed' &&
        record.job.status !== 'permanently_failed' &&
        record.job.status !== 'cancelled'
      ) {
        attemptSettled = true;
        this.handleWorkerEvent(record, {
          type: 'failed',
          error:
            stderrText.trim() ||
            `Isolated worker exited unexpectedly (code ${code ?? 1}).`,
        });
      }
      if (record.job.status !== 'completed') {
        void removeJobTempDir(record.job.id, this.tempDir);
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  }

  public listJobsForOwner(ownerId: string): DownloadJob[] {
    const results: DownloadJob[] = [];
    for (const record of this.jobs.values()) {
      if (record.ownerId === ownerId) {
        results.push({ ...record.job });
      }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public getJobForOwner(
    jobId: string,
    ownerId: string
  ): { ok: true; job: DownloadJob } | { ok: false; status: number; error: string } {
    const record = this.jobs.get(jobId);
    if (!record) {
      return { ok: false, status: 404, error: 'Download job not found.' };
    }
    if (record.ownerId !== ownerId) {
      return { ok: false, status: 403, error: 'Forbidden: job belongs to another session.' };
    }
    return { ok: true, job: { ...record.job } };
  }

  public issueFreshDownloadToken(
    jobId: string,
    requesterOwnerId: string
  ):
    | { ok: true; downloadToken: string; expiresAt: string }
    | { ok: false; status: number; error: string } {
    const record = this.jobs.get(jobId);
    if (!record) {
      return { ok: false, status: 404, error: 'Download job not found.' };
    }
    if (record.ownerId !== requesterOwnerId) {
      return { ok: false, status: 403, error: 'Forbidden: job belongs to another session.' };
    }
    if (record.job.status !== 'completed' || !record.filePath || !record.fileId) {
      return { ok: false, status: 410, error: 'Download file is no longer available.' };
    }
    if (record.job.expiresAt && Date.now() > Date.parse(record.job.expiresAt)) {
      return { ok: false, status: 410, error: 'Temporary download file has expired.' };
    }
    const confined = assertConfinedTempPath(record.filePath, this.tempDir);
    if (!fs.existsSync(confined)) {
      return { ok: false, status: 410, error: 'Temporary download file has expired.' };
    }

    const signed = createSignedDownloadToken({
      jobId: record.job.id,
      ownerId: record.ownerId,
      fileId: record.fileId,
      ttlMs: Math.min(this.fileTtlMs, 60_000),
    });
    record.job.downloadToken = signed.token;
    return {
      ok: true,
      downloadToken: signed.token,
      expiresAt: signed.expiresAt,
    };
  }

  public async cancelOrDeleteJob(
    jobId: string,
    ownerId: string
  ): Promise<{ ok: true; job: DownloadJob } | { ok: false; status: number; error: string }> {
    const record = this.jobs.get(jobId);
    if (!record) {
      return { ok: false, status: 404, error: 'Download job not found.' };
    }
    if (record.ownerId !== ownerId) {
      return { ok: false, status: 403, error: 'Forbidden: job belongs to another session.' };
    }

    const wasActive =
      record.job.status === 'queued' ||
      record.job.status === 'processing' ||
      record.job.status === 'verifying';

    record.cancelled = true;
    if (record.retryTimer) {
      clearTimeout(record.retryTimer);
      record.retryTimer = undefined;
    }

    if (wasActive) {
      record.job.status = 'cancelled';
      record.job.stageMessage = 'Cancelled by user.';
      record.job.updatedAt = new Date().toISOString();
      record.cancelFn?.();
      record.cancelFn = undefined;
    }

    await removeJobTempDir(record.job.id, this.tempDir);
    record.filePath = undefined;
    record.fileId = undefined;
    record.job.downloadUrl = undefined;
    record.job.downloadToken = undefined;

    return { ok: true, job: { ...record.job } };
  }

  public resolveDownloadableFile(params: {
    jobId: string;
    token: string;
    requesterOwnerId: string;
  }):
    | {
        ok: true;
        filePath: string;
        mimeType: string;
        filename: string;
      }
    | { ok: false; status: number; error: string } {
    const record = this.jobs.get(params.jobId);
    if (!record) {
      return { ok: false, status: 404, error: 'Download job not found.' };
    }
    if (record.ownerId !== params.requesterOwnerId) {
      return {
        ok: false,
        status: 403,
        error: 'Forbidden: job belongs to another session.',
      };
    }

    const tokenPayload = verifySignedDownloadToken(params.token, params.jobId, {
      consume: true,
    });
    if (!tokenPayload) {
      return {
        ok: false,
        status: 403,
        error: 'Invalid, expired, or already-used download token.',
      };
    }

    if (record.ownerId !== tokenPayload.ownerId) {
      return { ok: false, status: 403, error: 'Ownership mismatch for download token.' };
    }
    if (
      record.job.status !== 'completed' ||
      !record.filePath ||
      record.fileId !== tokenPayload.fileId
    ) {
      return { ok: false, status: 410, error: 'Download file is no longer available.' };
    }

    const confined = assertConfinedTempPath(record.filePath, this.tempDir);
    if (!fs.existsSync(confined)) {
      return { ok: false, status: 410, error: 'Temporary download file has expired.' };
    }

    record.job.downloadToken = undefined;

    const ext = record.job.verifiedMetadata?.container.toLowerCase() || 'bin';
    const shortId = record.job.id.slice(0, 8);
    return {
      ok: true,
      filePath: confined,
      mimeType: record.job.verifiedMetadata?.mimeType || 'application/octet-stream',
      filename: `downlyx-${shortId}.${ext}`,
    };
  }

  public async purgeJobsForOwner(ownerId: string): Promise<number> {
    let purgedCount = 0;
    for (const [jobId, record] of Array.from(this.jobs.entries())) {
      if (record.ownerId !== ownerId) continue;
      record.cancelled = true;
      if (record.retryTimer) {
        clearTimeout(record.retryTimer);
        record.retryTimer = undefined;
      }
      record.cancelFn?.();
      record.cancelFn = undefined;
      await removeJobTempDir(record.job.id, this.tempDir);
      this.jobs.delete(jobId);
      purgedCount++;
    }
    return purgedCount;
  }

  public async shutdown(): Promise<void> {
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = undefined;
    }
    for (const record of this.jobs.values()) {
      record.cancelled = true;
      if (record.retryTimer) {
        clearTimeout(record.retryTimer);
        record.retryTimer = undefined;
      }
      record.cancelFn?.();
      await removeJobTempDir(record.job.id, this.tempDir);
    }
    this.jobs.clear();
  }
}
