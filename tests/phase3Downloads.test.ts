import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import type { DownloadJob } from '../src/types/media.ts';
import { createMediaRouter } from '../server/routes/media.ts';
import { FirebaseTokenVerificationError, type VerifiedFirebaseUser } from '../server/security/firebaseAdmin.ts';
import { MediaWorkerManager } from '../server/worker/mediaWorkerManager.ts';
import {
  executeWorkerJob,
  type WorkerEvent,
  type WorkerTestOverrides,
} from '../server/worker/workerProcess.ts';

process.env.NODE_ENV = 'test';

let fixturesDir = '';
let sampleMp4Buffer: Buffer;
let sampleMp3Buffer: Buffer;

function generateMediaFixture(args: string[], outPath: string): Buffer {
  const res = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args, outPath], {
    shell: false,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`ffmpeg fixture failed: ${res.stderr}`);
  }
  return fs.readFileSync(outPath);
}

before(() => {
  fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-p3-fixtures-'));
  const mp4Path = path.join(fixturesDir, 'sample.mp4');
  const mp3Path = path.join(fixturesDir, 'sample.mp3');

  sampleMp4Buffer = generateMediaFixture(
    [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=0.5:size=160x120:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
    ],
    mp4Path
  );

  sampleMp3Buffer = generateMediaFixture(
    ['-f', 'lavfi', '-i', 'sine=frequency=523:duration=0.5', '-c:a', 'libmp3lame', '-b:a', '128k'],
    mp3Path
  );
});

after(() => {
  if (fixturesDir && fs.existsSync(fixturesDir)) {
    fs.rmSync(fixturesDir, { recursive: true, force: true });
  }
});

function createMockIncomingMessage(params: {
  statusCode?: number;
  headers?: Record<string, string>;
  chunks: Buffer[];
  chunkDelayMs?: number;
  abortAfterFirstChunk?: boolean;
}): http.IncomingMessage {
  const stream = new Readable({ read() {} }) as unknown as http.IncomingMessage;
  stream.statusCode = params.statusCode ?? 200;
  stream.headers = params.headers ?? {};

  let idx = 0;
  const pushNext = () => {
    if (stream.destroyed) return;
    if (idx >= params.chunks.length) {
      stream.push(null);
      return;
    }
    const chunk = params.chunks[idx++];
    stream.push(chunk);

    if (params.abortAfterFirstChunk && idx === 1) {
      setTimeout(() => {
        stream.emit('aborted');
        stream.destroy();
      }, 15);
      return;
    }

    if (params.chunkDelayMs) {
      setTimeout(pushNext, params.chunkDelayMs);
    } else {
      setImmediate(pushNext);
    }
  };

  if (params.chunkDelayMs) {
    setTimeout(pushNext, params.chunkDelayMs);
  } else {
    setImmediate(pushNext);
  }

  return stream;
}

async function runWorkerWithMock(params: {
  url: string;
  targetFormat: string;
  tempDir: string;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  overrides?: WorkerTestOverrides;
}): Promise<{ events: WorkerEvent[]; finalEvent: WorkerEvent }> {
  const events: WorkerEvent[] = [];
  const controller = new AbortController();
  const signal = params.signal ?? controller.signal;

  await executeWorkerJob(
    {
      jobId: 'test-job',
      url: params.url,
      targetFormat: params.targetFormat,
      maxBytes: params.maxBytes,
      timeoutMs: params.timeoutMs,
      tempDir: params.tempDir,
    },
    (ev) => events.push(ev),
    signal,
    {
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
      ...params.overrides,
    }
  );

  const finalEvent = events[events.length - 1];
  return { events, finalEvent };
}

function makeTestFirebaseToken(uid: string, ttlMs = 60_000): string {
  return Buffer.from(
    JSON.stringify({ uid, exp: Date.now() + ttlMs }),
    'utf8'
  ).toString('base64url');
}

async function verifyTestFirebaseToken(token: string): Promise<VerifiedFirebaseUser> {
  try {
    const parsed = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8')
    ) as { uid?: string; exp?: number };
    if (!parsed.uid || typeof parsed.exp !== 'number') {
      throw new FirebaseTokenVerificationError('Invalid token', 401);
    }
    if (Date.now() > parsed.exp) {
      throw new FirebaseTokenVerificationError('Expired token', 401, 'auth/id-token-expired');
    }
    return {
      uid: parsed.uid,
      email: `${parsed.uid}@example.com`,
      emailVerified: true,
      name: parsed.uid,
      picture: null,
      authTimeSeconds: Math.floor(Date.now() / 1000),
      issuedAtSeconds: Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    if (err instanceof FirebaseTokenVerificationError) throw err;
    throw new FirebaseTokenVerificationError('Invalid token', 401);
  }
}

async function withPhase3ApiServer(
  options: {
    tempDir: string;
    fileTtlMs?: number;
    maxConcurrentPerOwner?: number;
    customStreamOpener?: WorkerTestOverrides['customStreamOpener'];
  },
  fn: (baseUrl: string, manager: MediaWorkerManager) => Promise<void>
) {
  const manager = new MediaWorkerManager({
    tempDir: options.tempDir,
    fileTtlMs: options.fileTtlMs ?? 60_000,
    maxConcurrentPerOwner: options.maxConcurrentPerOwner ?? 3,
    disableAutoSweeper: true,
    customExecutor: async (input, onEvent, signal) => {
      await executeWorkerJob(input, onEvent, signal, {
        lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
        customStreamOpener: options.customStreamOpener,
      });
    },
  });

  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(
    '/api',
    createMediaRouter({
      skipNetworkMetadata: true,
      workerManager: manager,
      tokenVerifier: verifyTestFirebaseToken,
      rateLimitMax: 100,
      downloadRateLimitMax: 100,
    })
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    await fn(baseUrl, manager);
  } finally {
    await manager.shutdown();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

async function pollJobUntilDone(
  baseUrl: string,
  jobId: string,
  token: string
): Promise<DownloadJob> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${baseUrl}/api/downloads/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { job: DownloadJob };
    if (data.job.status === 'failed' || data.job.status === 'permanently_failed') {
      throw new Error(`Download worker failed: ${data.job.error || 'no worker error reported'}`);
    }
    if (data.job.status === 'completed' || data.job.status === 'cancelled') {
      return data.job;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Timed out polling job status');
}

describe('DOWNLYX Phase 3: Secure Media Download Engine', () => {
  it('completes valid direct MP4 download with FFprobe metadata and signed file retrieval', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t1-'));
    try {
      await withPhase3ApiServer(
        {
          tempDir,
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(sampleMp4Buffer.length),
              },
              chunks: [
                sampleMp4Buffer.subarray(0, 1024),
                sampleMp4Buffer.subarray(1024),
              ],
            }),
        },
        async (baseUrl) => {
          const token = makeTestFirebaseToken('uid-t1');

          const startRes = await fetch(`${baseUrl}/api/downloads`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              url: 'https://cdn.example.com/media/clip.mp4',
              targetFormat: 'MP4',
              userConfirmedPermission: true,
            }),
          });
          assert.equal(startRes.status, 202);
          const { job: initialJob } = (await startRes.json()) as { job: DownloadJob };
          assert.equal(initialJob.targetFormat, 'MP4');

          const finalJob = await pollJobUntilDone(baseUrl, initialJob.id, token);
          assert.equal(finalJob.status, 'completed');
          assert.equal(finalJob.verifiedMetadata?.container, 'MP4');
          assert.equal(finalJob.verifiedMetadata?.mimeType, 'video/mp4');
          assert.equal(finalJob.verifiedMetadata?.resolutionLabel, '160x120');
          assert.equal(finalJob.verifiedMetadata?.videoCodec, 'h264');
          assert.equal(finalJob.verifiedMetadata?.audioCodec, 'aac');
          assert.ok(finalJob.downloadUrl);
          assert.ok(finalJob.downloadToken);
          assert.equal(finalJob.downloadUrl.includes('token='), false);

          const fileRes = await fetch(`${baseUrl}${finalJob.downloadUrl}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Download-Token': finalJob.downloadToken!,
            },
          });
          assert.equal(fileRes.status, 200);
          assert.equal(fileRes.headers.get('x-content-type-options'), 'nosniff');
          assert.equal(fileRes.headers.get('referrer-policy'), 'no-referrer');
          assert.match(fileRes.headers.get('cache-control') ?? '', /no-store/);
          assert.match(fileRes.headers.get('content-disposition') ?? '', /attachment;/);
          const downloadedBytes = Buffer.from(await fileRes.arrayBuffer());
          assert.deepEqual(downloadedBytes, sampleMp4Buffer);
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports valid direct MP3 download and MP4-to-MP3 FFmpeg audio extraction', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t2-'));
    try {
      // Direct MP3
      const directMp3 = await runWorkerWithMock({
        url: 'https://cdn.example.com/audio/song.mp3',
        targetFormat: 'MP3',
        tempDir,
        overrides: {
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'audio/mpeg',
                'content-length': String(sampleMp3Buffer.length),
              },
              chunks: [sampleMp3Buffer],
            }),
        },
      });
      assert.equal(directMp3.finalEvent.type, 'completed');
      if (directMp3.finalEvent.type === 'completed') {
        assert.equal(directMp3.finalEvent.verifiedMetadata.container, 'MP3');
        assert.equal(directMp3.finalEvent.verifiedMetadata.audioCodec, 'mp3');
        assert.equal(directMp3.finalEvent.verifiedMetadata.videoCodec, undefined);
      }

      // MP4 -> MP3 extraction
      const extracted = await runWorkerWithMock({
        url: 'https://cdn.example.com/video/clip.mp4',
        targetFormat: 'MP3',
        tempDir,
        overrides: {
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(sampleMp4Buffer.length),
              },
              chunks: [sampleMp4Buffer],
            }),
        },
      });
      assert.equal(extracted.finalEvent.type, 'completed');
      if (extracted.finalEvent.type === 'completed') {
        assert.equal(extracted.finalEvent.verifiedMetadata.container, 'MP3');
        assert.equal(extracted.finalEvent.verifiedMetadata.mimeType, 'audio/mpeg');
        assert.equal(extracted.finalEvent.verifiedMetadata.audioCodec, 'mp3');
        assert.equal(extracted.finalEvent.verifiedMetadata.videoCodec, undefined);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects HTML or invalid MIME types disguised as direct media and cleans temp files', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t3-'));
    try {
      const htmlBuf = Buffer.from('<!DOCTYPE html><html><body>Login</body></html>');
      const res = await runWorkerWithMock({
        url: 'https://cdn.example.com/media/fake.mp4',
        targetFormat: 'MP4',
        tempDir,
        overrides: {
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'content-length': String(htmlBuf.length),
              },
              chunks: [htmlBuf],
            }),
        },
      });
      assert.equal(res.finalEvent.type, 'failed');
      if (res.finalEvent.type === 'failed') {
        assert.match(res.finalEvent.error, /blocked unsafe|text\/html/i);
      }
      assert.equal(fs.readdirSync(tempDir).length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects MIME/magic-byte mismatches and cleans temp files', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t4-'));
    try {
      const fakePayload = Buffer.from('<html><script>alert(1)</script></html>'.repeat(2));
      const res = await runWorkerWithMock({
        url: 'https://cdn.example.com/media/forged.mp4',
        targetFormat: 'MP4',
        tempDir,
        overrides: {
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(fakePayload.length),
              },
              chunks: [fakePayload],
            }),
        },
      });
      assert.equal(res.finalEvent.type, 'failed');
      if (res.finalEvent.type === 'failed') {
        assert.match(res.finalEvent.error, /signature/i);
      }
      assert.equal(fs.readdirSync(tempDir).length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces maximum file size limits on Content-Length and streaming bytes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t5-'));
    try {
      const headerOversize = await runWorkerWithMock({
        url: 'https://cdn.example.com/media/huge.mp4',
        targetFormat: 'MP4',
        tempDir,
        maxBytes: 1024,
        overrides: {
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': '2048',
              },
              chunks: [],
            }),
        },
      });
      assert.equal(headerOversize.finalEvent.type, 'failed');
      if (headerOversize.finalEvent.type === 'failed') {
        assert.match(headerOversize.finalEvent.error, /exceeds/i);
      }

      const streamOversize = await runWorkerWithMock({
        url: 'https://cdn.example.com/media/chunked-huge.mp4',
        targetFormat: 'MP4',
        tempDir,
        maxBytes: 1024,
        overrides: {
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: { 'content-type': 'video/mp4' },
              chunks: [sampleMp4Buffer],
            }),
        },
      });
      assert.equal(streamOversize.finalEvent.type, 'failed');
      if (streamOversize.finalEvent.type === 'failed') {
        assert.match(streamOversize.finalEvent.error, /exceeded maximum/i);
      }
      assert.equal(fs.readdirSync(tempDir).length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles interrupted download streams cleanly and removes partial temp files', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t6-'));
    try {
      const res = await runWorkerWithMock({
        url: 'https://cdn.example.com/media/cut-off.mp4',
        targetFormat: 'MP4',
        tempDir,
        overrides: {
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(sampleMp4Buffer.length),
              },
              chunks: [
                sampleMp4Buffer.subarray(0, 512),
                sampleMp4Buffer.subarray(512),
              ],
              abortAfterFirstChunk: true,
            }),
        },
      });
      assert.equal(res.finalEvent.type, 'failed');
      if (res.finalEvent.type === 'failed') {
        assert.match(res.finalEvent.error, /interrupted|incomplete/i);
      }
      assert.equal(fs.readdirSync(tempDir).length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces worker execution timeouts and cleans partial temp files', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t7-'));
    try {
      const res = await runWorkerWithMock({
        url: 'https://cdn.example.com/media/slow.mp4',
        targetFormat: 'MP4',
        tempDir,
        timeoutMs: 80,
        overrides: {
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(sampleMp4Buffer.length),
              },
              chunks: [
                sampleMp4Buffer.subarray(0, 256),
                sampleMp4Buffer.subarray(256),
              ],
              chunkDelayMs: 300,
            }),
        },
      });
      assert.equal(res.finalEvent.type, 'failed');
      if (res.finalEvent.type === 'failed') {
        assert.match(res.finalEvent.error, /timed out/i);
      }
      assert.equal(fs.readdirSync(tempDir).length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks redirect attacks to localhost, cloud metadata, and HTTP downgrades', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t8-'));
    try {
      const targets = [
        'https://127.0.0.1/internal.mp4',
        'https://169.254.169.254/latest/meta-data/',
        'http://cdn.example.com/downgrade.mp4',
      ];

      for (const redirectTarget of targets) {
        const res = await runWorkerWithMock({
          url: 'https://cdn.example.com/media/redirect.mp4',
          targetFormat: 'MP4',
          tempDir,
          overrides: {
            customStreamOpener: async () =>
              createMockIncomingMessage({
                statusCode: 302,
                headers: { location: redirectTarget },
                chunks: [],
              }),
          },
        });
        assert.equal(res.finalEvent.type, 'failed');
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces authorization boundaries, ownership checks, and YouTube/Instagram restrictions', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t9-'));
    try {
      await withPhase3ApiServer(
        {
          tempDir,
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(sampleMp4Buffer.length),
              },
              chunks: [sampleMp4Buffer],
            }),
        },
        async (baseUrl) => {
          // 1. Unauthenticated request rejected (401)
          const unauth = await fetch(`${baseUrl}/api/downloads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'https://cdn.example.com/a.mp4',
              userConfirmedPermission: true,
            }),
          });
          assert.equal(unauth.status, 401);

          const sessA = { token: makeTestFirebaseToken('uid-a') };
          const sessB = { token: makeTestFirebaseToken('uid-b') };

          // 2. Missing permission confirmation rejected (403)
          const noPerm = await fetch(`${baseUrl}/api/downloads`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${sessA.token}`,
            },
            body: JSON.stringify({
              url: 'https://cdn.example.com/a.mp4',
              targetFormat: 'MP4',
              userConfirmedPermission: false,
            }),
          });
          assert.equal(noPerm.status, 403);

          // 3. YouTube & Instagram restricted (403)
          const ytRes = await fetch(`${baseUrl}/api/downloads`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${sessA.token}`,
            },
            body: JSON.stringify({
              url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              targetFormat: 'MP4',
              userConfirmedPermission: true,
            }),
          });
          assert.equal(ytRes.status, 403);

          const igStoryRes = await fetch(`${baseUrl}/api/downloads`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${sessA.token}`,
            },
            body: JSON.stringify({
              url: 'https://www.instagram.com/stories/user/123456/',
              targetFormat: 'MP4',
              userConfirmedPermission: true,
            }),
          });
          assert.equal(igStoryRes.status, 403);

          // 4. Cross-session job ownership check (403)
          const created = (await (
            await fetch(`${baseUrl}/api/downloads`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sessA.token}`,
              },
              body: JSON.stringify({
                url: 'https://cdn.example.com/a.mp4',
                targetFormat: 'MP4',
                userConfirmedPermission: true,
              }),
            })
          ).json()) as { job: DownloadJob };

          const crossRead = await fetch(`${baseUrl}/api/downloads/${created.job.id}`, {
            headers: { Authorization: `Bearer ${sessB.token}` },
          });
          assert.equal(crossRead.status, 403);

          const crossDel = await fetch(`${baseUrl}/api/downloads/${created.job.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${sessB.token}` },
          });
          assert.equal(crossDel.status, 403);

          // 5. Tampered signed download token rejected (403)
          const completed = await pollJobUntilDone(baseUrl, created.job.id, sessA.token);
          assert.equal(completed.status, 'completed');
          const tamperedFile = await fetch(
            `${baseUrl}/api/downloads/${created.job.id}/file`,
            {
              headers: {
                Authorization: `Bearer ${sessA.token}`,
                'X-Download-Token': 'invalid.token',
              },
            }
          );
          assert.equal(tamperedFile.status, 403);
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('cancels active download jobs and deletes temporary files immediately', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t10-'));
    try {
      await withPhase3ApiServer(
        {
          tempDir,
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(sampleMp4Buffer.length),
              },
              chunks: [
                sampleMp4Buffer.subarray(0, 512),
                sampleMp4Buffer.subarray(512),
              ],
              chunkDelayMs: 1200,
            }),
        },
        async (baseUrl) => {
          const token = makeTestFirebaseToken('uid-cancel');

          const startRes = await fetch(`${baseUrl}/api/downloads`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              url: 'https://cdn.example.com/media/cancel-me.mp4',
              targetFormat: 'MP4',
              userConfirmedPermission: true,
            }),
          });
          assert.equal(startRes.status, 202);
          const { job } = (await startRes.json()) as { job: DownloadJob };

          await new Promise((r) => setTimeout(r, 30));
          const delRes = await fetch(`${baseUrl}/api/downloads/${job.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          assert.equal(delRes.status, 200);
          const delData = (await delRes.json()) as { job: DownloadJob };
          assert.equal(delData.job.status, 'cancelled');

          await new Promise((r) => setTimeout(r, 40));
          assert.equal(fs.readdirSync(tempDir).length, 0);
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('cleans up expired temporary download files via TTL sweeper', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t11-'));
    try {
      await withPhase3ApiServer(
        {
          tempDir,
          fileTtlMs: 60,
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(sampleMp4Buffer.length),
              },
              chunks: [sampleMp4Buffer],
            }),
        },
        async (baseUrl, manager) => {
          const token = makeTestFirebaseToken('uid-ttl');

          const { job } = (await (
            await fetch(`${baseUrl}/api/downloads`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                url: 'https://cdn.example.com/media/expiring.mp4',
                targetFormat: 'MP4',
                userConfirmedPermission: true,
              }),
            })
          ).json()) as { job: DownloadJob };

          const done = await pollJobUntilDone(baseUrl, job.id, token);
          assert.equal(done.status, 'completed');
          assert.ok(done.downloadToken);
          assert.equal(fs.readdirSync(tempDir).length, 1);

          await new Promise((r) => setTimeout(r, 90));
          await manager.cleanupExpiredFiles();

          assert.equal(fs.readdirSync(tempDir).length, 0);
          const expiredFetch = await fetch(`${baseUrl}${done.downloadUrl}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Download-Token': done.downloadToken!,
            },
          });
          assert.equal(expiredFetch.status, 403);
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('processes concurrent download jobs safely and enforces max concurrent cap (429)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t12-'));
    try {
      await withPhase3ApiServer(
        {
          tempDir,
          maxConcurrentPerOwner: 3,
          customStreamOpener: async () =>
            createMockIncomingMessage({
              statusCode: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(sampleMp4Buffer.length),
              },
              chunks: [
                sampleMp4Buffer.subarray(0, 512),
                sampleMp4Buffer.subarray(512),
              ],
              chunkDelayMs: 60,
            }),
        },
        async (baseUrl) => {
          const token = makeTestFirebaseToken('uid-conc');

          const startOne = (idx: number) =>
            fetch(`${baseUrl}/api/downloads`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                url: `https://cdn.example.com/media/concurrent-${idx}.mp4`,
                targetFormat: 'MP4',
                userConfirmedPermission: true,
              }),
            });

          const [r1, r2, r3, r4] = await Promise.all([
            startOne(1),
            startOne(2),
            startOne(3),
            startOne(4),
          ]);

          const statuses = [r1.status, r2.status, r3.status, r4.status].sort();
          assert.deepEqual(statuses, [202, 202, 202, 429]);

          const acceptedResponses = [r1, r2, r3, r4].filter((r) => r.status === 202);
          const createdJobs = (await Promise.all(
            acceptedResponses.map(async (r) => ((await r.json()) as { job: DownloadJob }).job)
          )) as DownloadJob[];

          const completedJobs = await Promise.all(
            createdJobs.map((j) => pollJobUntilDone(baseUrl, j.id, token))
          );

          for (const done of completedJobs) {
            assert.equal(done.status, 'completed');
            assert.ok(done.downloadUrl);
          }

          // Orphan sweep should leave active completed files untouched while below TTL
          await fsPromises.access(tempDir);
          assert.equal(fs.readdirSync(tempDir).length, 3);
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('spawns isolated child worker natively under Node 22 with memory cap and stripped secrets', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-t13-'));
    try {
      const workerScript = path.resolve(process.cwd(), 'server/worker/workerProcess.ts');
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--max-old-space-size=256', workerScript],
          {
            shell: false,
            env: {
              PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
              TMPDIR: tempDir,
              LANG: 'C.UTF-8',
              DOWNLYX_WORKER_MODE: '1',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c: Buffer) => {
          stdout += c.toString('utf8');
        });
        child.stderr.on('data', (c: Buffer) => {
          stderr += c.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', () => {
          if (stderr && !stdout) reject(new Error(stderr));
          else resolve(stdout);
        });

        child.stdin.write(
          JSON.stringify({
            jobId: 'child-test',
            url: 'https://127.0.0.1/blocked.mp4',
            targetFormat: 'MP4',
            tempDir,
          })
        );
        child.stdin.end();
      });

      const lastLine = output.trim().split('\n').pop() || '';
      const ev = JSON.parse(lastLine) as WorkerEvent;
      assert.equal(ev.type, 'failed');
      if (ev.type === 'failed') {
        assert.match(ev.error, /blocked|private|localhost/i);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
