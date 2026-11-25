import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import type { DownloadJob } from '../src/types/media.ts';
import { createMediaRouter } from '../server/routes/media.ts';
import { FirebaseTokenVerificationError, type VerifiedFirebaseUser } from '../server/security/firebaseAdmin.ts';
import {
  assertConfinedTempPath,
  ensureTempStorageDir,
} from '../server/storage/tempStorage.ts';
import { verifyMediaIntegrity } from '../server/worker/ffmpegProcessor.ts';
import { MediaWorkerManager } from '../server/worker/mediaWorkerManager.ts';
import { executeWorkerJob } from '../server/worker/workerProcess.ts';

process.env.NODE_ENV = 'test';

let fixturesDir = '';
let sampleMp4Buffer: Buffer;

before(() => {
  fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-p31-fix-'));
  const mp4Path = path.join(fixturesDir, 'sample.mp4');
  const res = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=0.6:size=160x120:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.6',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      mp4Path,
    ],
    { shell: false, encoding: 'utf8' }
  );
  if (res.status !== 0) throw new Error(res.stderr);
  sampleMp4Buffer = fs.readFileSync(mp4Path);
});

after(() => {
  if (fixturesDir && fs.existsSync(fixturesDir)) {
    fs.rmSync(fixturesDir, { recursive: true, force: true });
  }
});

function mockMp4Stream(): http.IncomingMessage {
  const s = new Readable({ read() {} }) as unknown as http.IncomingMessage;
  s.statusCode = 200;
  s.headers = {
    'content-type': 'video/mp4',
    'content-length': String(sampleMp4Buffer.length),
  };
  setImmediate(() => {
    s.push(sampleMp4Buffer);
    s.push(null);
  });
  return s;
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

async function withAuditServer(
  opts: {
    tempDir: string;
    sessionTtlMs?: number;
    maxTotalStorageBytes?: number;
  },
  fn: (baseUrl: string, manager: MediaWorkerManager) => Promise<void>
) {
  const manager = new MediaWorkerManager({
    tempDir: opts.tempDir,
    maxTotalStorageBytes: opts.maxTotalStorageBytes,
    disableAutoSweeper: true,
    customExecutor: async (input, onEvent, signal) => {
      await executeWorkerJob(input, onEvent, signal, {
        lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
        customStreamOpener: async () => mockMp4Stream(),
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

async function waitCompleted(baseUrl: string, jobId: string, token: string): Promise<DownloadJob> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${baseUrl}/api/downloads/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { job: DownloadJob };
    if (data.job.status === 'completed' || data.job.status === 'failed') {
      return data.job;
    }
    await new Promise((r) => setTimeout(r, 35));
  }
  throw new Error('Timed out');
}

describe('DOWNLYX Phase 3.1: Production Security Audit Tests', () => {
  it('prevents download token replay, query-string tokens, and cross-session redemption', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-a1-'));
    try {
      await withAuditServer({ tempDir }, async (baseUrl) => {
        const sessA = { token: makeTestFirebaseToken('audit-user-a') };
        const sessB = { token: makeTestFirebaseToken('audit-user-b') };

        const start = (await (
          await fetch(`${baseUrl}/api/downloads`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${sessA.token}`,
            },
            body: JSON.stringify({
              url: 'https://cdn.example.com/media/audit.mp4',
              targetFormat: 'MP4',
              userConfirmedPermission: true,
            }),
          })
        ).json()) as { job: DownloadJob };

        const done = await waitCompleted(baseUrl, start.job.id, sessA.token);
        assert.equal(done.status, 'completed');
        assert.ok(done.downloadToken);

        // 1. Rejects query-string token transport (400)
        const qsRes = await fetch(
          `${baseUrl}/api/downloads/${done.id}/file?token=${done.downloadToken}`,
          { headers: { Authorization: `Bearer ${sessA.token}` } }
        );
        assert.equal(qsRes.status, 400);

        // 2. Rejects cross-session redemption even with valid token (403)
        const crossRes = await fetch(`${baseUrl}/api/downloads/${done.id}/file`, {
          headers: {
            Authorization: `Bearer ${sessB.token}`,
            'X-Download-Token': done.downloadToken!,
          },
        });
        assert.equal(crossRes.status, 403);

        // 3. First valid download succeeds (200)
        const firstRes = await fetch(`${baseUrl}/api/downloads/${done.id}/file`, {
          headers: {
            Authorization: `Bearer ${sessA.token}`,
            'X-Download-Token': done.downloadToken!,
          },
        });
        assert.equal(firstRes.status, 200);
        assert.equal(firstRes.headers.get('referrer-policy'), 'no-referrer');
        assert.match(firstRes.headers.get('cache-control') ?? '', /no-store/);

        // 4. Replay of the SAME token fails (403)
        const replayRes = await fetch(`${baseUrl}/api/downloads/${done.id}/file`, {
          headers: {
            Authorization: `Bearer ${sessA.token}`,
            'X-Download-Token': done.downloadToken!,
          },
        });
        assert.equal(replayRes.status, 403);

        // 5. Owning session can mint a fresh single-use ticket; Session B cannot
        const crossTicket = await fetch(`${baseUrl}/api/downloads/${done.id}/token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${sessB.token}` },
        });
        assert.equal(crossTicket.status, 403);

        const freshTicketRes = await fetch(`${baseUrl}/api/downloads/${done.id}/token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${sessA.token}` },
        });
        assert.equal(freshTicketRes.status, 200);
        const { downloadToken: secondToken } = (await freshTicketRes.json()) as {
          downloadToken: string;
        };
        const secondRes = await fetch(`${baseUrl}/api/downloads/${done.id}/file`, {
          headers: {
            Authorization: `Bearer ${sessA.token}`,
            'X-Download-Token': secondToken,
          },
        });
        assert.equal(secondRes.status, 200);
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects expired Firebase sessions cleanly with 401', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-a2-'));
    try {
      await withAuditServer({ tempDir }, async (baseUrl) => {
        const token = makeTestFirebaseToken('audit-expired', 40);

        await new Promise((r) => setTimeout(r, 70));
        const res = await fetch(`${baseUrl}/api/downloads`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 401);
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces 0o700 temp directory perms, blocks symlink escapes, and enforces global disk quota', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-a3-'));
    try {
      fs.chmodSync(tempDir, 0o755);
      const ensured = ensureTempStorageDir(tempDir);
      const mode = fs.statSync(ensured).mode & 0o777;
      assert.equal(mode, 0o700);

      // Symlink escape test
      const linkPath = path.join(ensured, 'evil-link.mp4');
      fs.symlinkSync('/etc/hosts', linkPath);
      assert.throws(() => assertConfinedTempPath(linkPath, ensured), /symlink/i);
      fs.unlinkSync(linkPath);

      // Disk quota enforcement test
      await withAuditServer(
        { tempDir: ensured, maxTotalStorageBytes: sampleMp4Buffer.length },
        async (baseUrl) => {
          const token = makeTestFirebaseToken('audit-quota');

          const r1 = await fetch(`${baseUrl}/api/downloads`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              url: 'https://cdn.example.com/media/first.mp4',
              targetFormat: 'MP4',
              userConfirmedPermission: true,
            }),
          });
          assert.equal(r1.status, 202);
          const { job } = (await r1.json()) as { job: DownloadJob };
          await waitCompleted(baseUrl, job.id, token);

          const r2 = await fetch(`${baseUrl}/api/downloads`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              url: 'https://cdn.example.com/media/second.mp4',
              targetFormat: 'MP4',
              userConfirmedPermission: true,
            }),
          });
          assert.equal(r2.status, 507);
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces FFmpeg maximum media duration limit and documents worker isolation truthfully', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-a4-'));
    try {
      const targetMp4 = path.join(tempDir, 'duration-test.mp4');
      fs.writeFileSync(targetMp4, sampleMp4Buffer);

      await assert.rejects(
        () =>
          verifyMediaIntegrity({
            filePath: targetMp4,
            expectedCategory: 'Video',
            baseDir: tempDir,
            maxDurationSeconds: 0.1,
          }),
        /exceeds maximum allowed limit/i
      );

      const manager = new MediaWorkerManager({
        tempDir,
        disableAutoSweeper: true,
      });
      const isolation = manager.getWorkerIsolationSummary();
      assert.equal(isolation.processIsolation, true);
      assert.equal(isolation.osNetworkNamespaceEnforced, false);
      assert.equal(isolation.containerDeploymentRequiredForNetNs, true);
      await manager.shutdown();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
