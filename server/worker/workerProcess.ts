import fs from 'fs';
import fsPromises from 'fs/promises';
import http from 'http';
import https from 'https';
import type { IncomingMessage } from 'http';
import type { VerifiedMediaMetadata } from '../../src/types/media.ts';
import { validateExternalHttpsUrl } from '../../src/utils/platformDetector.ts';
import { verifyMediaMimeAndSignature } from '../security/mediaSignature.ts';
import {
  parseStrictContentLength,
  resolveAndValidatePublicIps,
  type DnsLookupFn,
  type ResolvedAddress,
} from '../security/urlSecurity.ts';
import {
  DEFAULT_TEMP_STORAGE_DIR,
  createRandomizedTempPath,
  ensureJobTempSubdir,
  removeJobTempDir,
  safeRemoveFile,
} from '../storage/tempStorage.ts';
import {
  DEFAULT_MAX_MEDIA_DURATION_SECONDS,
  inspectMediaWithFfprobe,
  transformMediaWithFfmpeg,
  verifyMediaIntegrity,
} from './ffmpegProcessor.ts';

export interface WorkerJobInput {
  jobId: string;
  url: string;
  targetFormat: string;
  maxBytes?: number;
  maxDurationSeconds?: number;
  timeoutMs?: number;
  tempDir?: string;
}

export type WorkerEvent =
  | {
      type: 'progress';
      status: 'processing' | 'verifying';
      bytesDownloaded: number;
      totalBytes: number | null;
      progressPercent: number | null;
      stageMessage: string;
    }
  | {
      type: 'completed';
      fileId: string;
      filePath: string;
      verifiedMetadata: VerifiedMediaMetadata;
    }
  | {
      type: 'failed';
      error: string;
    };

export interface WorkerTestOverrides {
  lookupFn?: DnsLookupFn;
  allowLocalhostTestHttps?: boolean;
  skipFfmpegProcessing?: boolean;
  customStreamOpener?: (params: {
    url: URL;
    pinnedAddress: ResolvedAddress;
    signal: AbortSignal;
  }) => Promise<IncomingMessage>;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_TIMEOUT_MS = 90_000; // 90 seconds
const MAX_REDIRECT_HOPS = 3;

const CONTAINER_MIME_MAP: Record<string, string> = {
  MP4: 'video/mp4',
  WEBM: 'video/webm',
  MOV: 'video/quicktime',
  MP3: 'audio/mpeg',
  WAV: 'audio/wav',
  M4A: 'audio/mp4',
  OGG: 'audio/ogg',
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  JPG: 'image/jpeg',
  WEBP: 'image/webp',
};

function categoryFromMime(mime: string): 'Video' | 'Audio' | 'Image' {
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.startsWith('image/')) return 'Image';
  return 'Video';
}

function openPinnedHttpsResponse(params: {
  url: URL;
  pinnedAddress: ResolvedAddress;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (params.signal.aborted) {
      reject(new Error('Download cancelled.'));
      return;
    }

    const req = https.request(
      {
        protocol: 'https:',
        hostname: params.url.hostname,
        port: params.url.port ? Number(params.url.port) : 443,
        path: `${params.url.pathname}${params.url.search}`,
        method: 'GET',
        agent: false, // Disable connection pooling so validated DNS IP pinning applies to every socket
        servername: params.url.hostname,
        rejectUnauthorized: true,
        headers: {
          Host: params.url.hostname,
          Accept: 'video/*, audio/*, image/*;q=0.9, */*;q=0.1',
          'User-Agent': 'DOWNLYX-Media-Worker/3.1',
        },
        lookup: (requestedHost, opts, cb) => {
          if (requestedHost.toLowerCase() !== params.url.hostname.toLowerCase()) {
            cb(new Error('Pinned lookup hostname mismatch.'), '', 4);
            return;
          }
          if (typeof opts === 'object' && opts !== null && opts.all) {
            cb(null, [
              { address: params.pinnedAddress.address, family: params.pinnedAddress.family },
            ]);
          } else {
            cb(null, params.pinnedAddress.address, params.pinnedAddress.family);
          }
        },
      },
      (res) => {
        cleanup();
        resolve(res);
      }
    );

    const onAbort = () => {
      cleanup();
      req.destroy(new Error('Download cancelled.'));
    };

    const timer = setTimeout(() => {
      cleanup();
      req.destroy(new Error('Media download timed out.'));
    }, params.timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      params.signal.removeEventListener('abort', onAbort);
    };

    params.signal.addEventListener('abort', onAbort, { once: true });

    req.on('error', (err) => {
      cleanup();
      reject(err);
    });

    req.end();
  });
}

export async function executeWorkerJob(
  input: WorkerJobInput,
  onEvent: (ev: WorkerEvent) => void,
  signal: AbortSignal,
  overrides?: WorkerTestOverrides
): Promise<void> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDurationSeconds =
    input.maxDurationSeconds ?? DEFAULT_MAX_MEDIA_DURATION_SECONDS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tempDir = input.tempDir ?? DEFAULT_TEMP_STORAGE_DIR;

  let rawTempPath: string | null = null;
  let finalTempPath: string | null = null;

  const jobAbortController = new AbortController();
  const onParentAbort = () => jobAbortController.abort();
  signal.addEventListener('abort', onParentAbort, { once: true });

  const overallTimer = setTimeout(() => {
    jobAbortController.abort();
  }, timeoutMs);

  try {
    ensureJobTempSubdir(input.jobId, tempDir);

    let currentUrlStr = input.url;
    let responseStream: IncomingMessage | null = null;

    // Validate initial URL and up to MAX_REDIRECT_HOPS redirects independently
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      let currentUrl: URL;
      let pinnedAddress: ResolvedAddress;

      if (overrides?.allowLocalhostTestHttps) {
        currentUrl = new URL(currentUrlStr);
        if (currentUrl.protocol !== 'https:' && currentUrl.protocol !== 'http:') {
          throw new Error(`Protocol "${currentUrl.protocol}" is blocked.`);
        }
        pinnedAddress = { address: '127.0.0.1', family: 4 };
      } else {
        const sec = validateExternalHttpsUrl(currentUrlStr);
        if (!sec.valid || !sec.parsed) {
          throw new Error(sec.error || 'Media URL failed HTTPS security validation.');
        }
        currentUrl = sec.parsed;

        const dnsResult = await resolveAndValidatePublicIps(
          currentUrl.hostname,
          overrides?.lookupFn
        );
        if (!dnsResult.valid || dnsResult.addresses.length === 0) {
          throw new Error(dnsResult.error || 'DNS validation rejected media host.');
        }
        pinnedAddress =
          dnsResult.addresses.find((a) => a.family === 4) ?? dnsResult.addresses[0];
      }

      onEvent({
        type: 'progress',
        status: 'processing',
        bytesDownloaded: 0,
        totalBytes: null,
        progressPercent: 0,
        stageMessage:
          hop === 0
            ? 'Connecting to validated destination IP...'
            : `Validating redirect hop ${hop}...`,
      });

      const res = overrides?.customStreamOpener
        ? await overrides.customStreamOpener({
            url: currentUrl,
            pinnedAddress,
            signal: jobAbortController.signal,
          })
        : overrides?.allowLocalhostTestHttps && currentUrl.protocol === 'http:'
        ? await new Promise<IncomingMessage>((resolve, reject) => {
            const req = http.get(currentUrl.toString(), resolve);
            req.on('error', reject);
          })
        : await openPinnedHttpsResponse({
            url: currentUrl,
            pinnedAddress,
            timeoutMs,
            signal: jobAbortController.signal,
          });

      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        const rawLoc = res.headers.location;
        const loc = Array.isArray(rawLoc) ? rawLoc[0] : rawLoc;
        if (!loc) {
          throw new Error('Redirect response missing Location header.');
        }
        if (hop >= MAX_REDIRECT_HOPS) {
          throw new Error('Exceeded maximum allowed redirect hops.');
        }
        const resolvedNext = new URL(loc, currentUrl).toString();
        const nextSec = validateExternalHttpsUrl(resolvedNext);
        if (!nextSec.valid) {
          throw new Error(
            nextSec.error || 'Redirect destination blocked by security policy.'
          );
        }
        currentUrlStr = nextSec.normalizedUrl;
        continue;
      }

      if (status < 200 || status >= 300) {
        res.destroy();
        throw new Error(`Media server returned HTTP ${status}.`);
      }

      responseStream = res;
      break;
    }

    if (!responseStream) {
      throw new Error('Failed to open verified media stream.');
    }

    // Validate Content-Length strictly before streaming
    const clCheck = parseStrictContentLength(
      responseStream.headers['content-length'],
      maxBytes
    );
    if (!clCheck.valid) {
      responseStream.destroy();
      throw new Error(clCheck.reason || 'Invalid or oversized Content-Length.');
    }

    const totalBytes = clCheck.length;
    const rawContentType = responseStream.headers['content-type'];
    const contentTypeStr = Array.isArray(rawContentType)
      ? rawContentType[0]
      : rawContentType;

    // Stream response directly to O_EXCL atomic randomized temp file inside job scratch subdir
    const rawCreated = createRandomizedTempPath('part', tempDir, input.jobId);
    rawTempPath = rawCreated.filePath;

    let bytesDownloaded = 0;
    let signatureChecked = false;
    let detectedContainer = '';
    let verifiedMime = '';
    const headerBufferChunks: Buffer[] = [];
    let headerBytesCollected = 0;

    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(rawTempPath!, {
        flags: 'wx',
        mode: 0o600,
      });
      let settled = false;

      const failStream = (err: Error) => {
        if (settled) return;
        settled = true;
        jobAbortController.signal.removeEventListener('abort', onAbort);
        responseStream!.destroy();
        writeStream.destroy();
        reject(err);
      };

      const onAbort = () => {
        failStream(
          new Error(
            signal.aborted
              ? 'Download cancelled by user.'
              : 'Worker execution timed out.'
          )
        );
      };

      jobAbortController.signal.addEventListener('abort', onAbort, { once: true });

      responseStream!.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytesDownloaded += chunk.length;

        if (bytesDownloaded > maxBytes) {
          failStream(
            new Error(`Media stream exceeded maximum allowed size (${maxBytes} bytes).`)
          );
          return;
        }

        if (!signatureChecked) {
          headerBufferChunks.push(chunk);
          headerBytesCollected += chunk.length;
          if (headerBytesCollected >= 32 || (totalBytes !== null && bytesDownloaded >= totalBytes)) {
            const combinedHeader = Buffer.concat(headerBufferChunks);
            const sigResult = verifyMediaMimeAndSignature(
              contentTypeStr,
              combinedHeader
            );
            if (!sigResult.verified || !sigResult.detectedContainer || !sigResult.mimeType) {
              failStream(new Error(sigResult.reason));
              return;
            }
            signatureChecked = true;
            detectedContainer = sigResult.detectedContainer;
            verifiedMime = sigResult.mimeType;
          }
        }

        const canContinue = writeStream.write(chunk);
        if (!canContinue) {
          responseStream!.pause();
          writeStream.once('drain', () => responseStream!.resume());
        }

        const progressPercent =
          totalBytes && totalBytes > 0
            ? Math.min(99, Math.round((bytesDownloaded / totalBytes) * 100))
            : null;

        onEvent({
          type: 'progress',
          status: 'processing',
          bytesDownloaded,
          totalBytes,
          progressPercent,
          stageMessage: 'Streaming verified media chunks...',
        });
      });

      responseStream!.on('aborted', () => {
        failStream(new Error('Media download stream was interrupted before completion.'));
      });

      responseStream!.on('error', (err) => {
        failStream(err);
      });

      responseStream!.on('end', () => {
        if (settled) return;
        if (!signatureChecked) {
          const combinedHeader = Buffer.concat(headerBufferChunks);
          const sigResult = verifyMediaMimeAndSignature(
            contentTypeStr,
            combinedHeader
          );
          if (!sigResult.verified || !sigResult.detectedContainer || !sigResult.mimeType) {
            failStream(new Error(sigResult.reason));
            return;
          }
          signatureChecked = true;
          detectedContainer = sigResult.detectedContainer;
          verifiedMime = sigResult.mimeType;
        }
        writeStream.end();
      });

      writeStream.on('error', (err) => {
        failStream(err);
      });

      writeStream.on('finish', () => {
        if (settled) return;
        if (totalBytes !== null && bytesDownloaded < totalBytes) {
          failStream(
            new Error(
              `Incomplete download: received ${bytesDownloaded} of ${totalBytes} expected bytes.`
            )
          );
          return;
        }
        settled = true;
        jobAbortController.signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });

    onEvent({
      type: 'progress',
      status: 'verifying',
      bytesDownloaded,
      totalBytes: bytesDownloaded,
      progressPercent: 100,
      stageMessage: 'Verifying container integrity and running FFmpeg processing...',
    });

    const sourceCategory = categoryFromMime(verifiedMime);
    const normalizedTarget = (input.targetFormat || detectedContainer)
      .toUpperCase()
      .replace('JPG', 'JPEG');
    const normalizedSource = detectedContainer.toUpperCase().replace('JPG', 'JPEG');

    const finalCreated = createRandomizedTempPath(
      normalizedTarget.toLowerCase(),
      tempDir,
      input.jobId
    );
    finalTempPath = finalCreated.filePath;

    let verifiedMetadata: VerifiedMediaMetadata;

    if (overrides?.skipFfmpegProcessing) {
      await fsPromises.rename(rawTempPath, finalTempPath);
      rawTempPath = null;
      const stat = await fsPromises.stat(finalTempPath);
      verifiedMetadata = {
        container: normalizedSource,
        mimeType: verifiedMime,
        sizeBytes: stat.size,
      };
    } else {
      const sourceInspection = await verifyMediaIntegrity({
        filePath: rawTempPath,
        expectedCategory: sourceCategory,
        baseDir: tempDir,
        maxDurationSeconds,
        signal: jobAbortController.signal,
      });

      const needsConversion = normalizedTarget !== normalizedSource;
      if (needsConversion) {
        await transformMediaWithFfmpeg({
          inputPath: rawTempPath,
          outputPath: finalTempPath,
          targetFormat: normalizedTarget,
          sourceContainer: normalizedSource,
          hasAudio: sourceInspection.hasAudio,
          hasVideo: sourceInspection.hasVideo,
          baseDir: tempDir,
          maxDurationSeconds,
          maxOutputBytes: maxBytes,
          signal: jobAbortController.signal,
        });
        await safeRemoveFile(rawTempPath, tempDir);
        rawTempPath = null;
      } else {
        await fsPromises.rename(rawTempPath, finalTempPath);
        rawTempPath = null;
      }

      const finalInspection = await inspectMediaWithFfprobe(
        finalTempPath,
        tempDir,
        jobAbortController.signal
      );
      const stat = await fsPromises.stat(finalTempPath);

      verifiedMetadata = {
        container: normalizedTarget,
        mimeType: CONTAINER_MIME_MAP[normalizedTarget] || verifiedMime,
        sizeBytes: stat.size,
        durationSeconds: finalInspection.durationSeconds,
        width: finalInspection.width,
        height: finalInspection.height,
        resolutionLabel: finalInspection.resolutionLabel,
        videoCodec: finalInspection.videoCodec,
        audioCodec: finalInspection.audioCodec,
      };
    }

    onEvent({
      type: 'completed',
      fileId: finalCreated.fileId,
      filePath: finalTempPath,
      verifiedMetadata,
    });
  } catch (err) {
    await safeRemoveFile(rawTempPath, tempDir);
    await safeRemoveFile(finalTempPath, tempDir);
    await removeJobTempDir(input.jobId, tempDir);
    const msg =
      err instanceof Error ? err.message : 'Media worker failed unexpectedly.';
    onEvent({ type: 'failed', error: msg });
  } finally {
    clearTimeout(overallTimer);
    signal.removeEventListener('abort', onParentAbort);
  }
}

// Standalone isolated child-process entry point
if (process.env.DOWNLYX_WORKER_MODE === '1') {
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());

  let stdinBuf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    stdinBuf += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(stdinBuf) as WorkerJobInput;
      void executeWorkerJob(
        payload,
        (ev) => {
          process.stdout.write(`${JSON.stringify(ev)}\n`);
        },
        controller.signal
      ).then(() => {
        process.exit(0);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid worker input.';
      process.stdout.write(`${JSON.stringify({ type: 'failed', error: msg })}\n`);
      process.exit(1);
    }
  });
}
