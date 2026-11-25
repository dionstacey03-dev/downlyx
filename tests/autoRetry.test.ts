import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createMediaRouter } from '../server/routes/media.ts';
import type { VerifiedFirebaseUser } from '../server/security/firebaseAdmin.ts';
import {
  MAX_AUTO_RETRIES,
  MediaWorkerManager,
} from '../server/worker/mediaWorkerManager.ts';

process.env.NODE_ENV = 'test';

async function waitFor<T>(
  check: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs = 3000,
  intervalMs = 20
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await check();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

describe('Auto-Retry Worker Lifecycle & Preferences Integration', () => {
  let tempRoot = '';

  before(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-retry-test-'));
  });

  after(() => {
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('sets status directly to failed on first failure when autoRetry is disabled', async () => {
    let attempts = 0;
    const manager = new MediaWorkerManager({
      tempDir: path.join(tempRoot, 'no-retry'),
      disableAutoSweeper: true,
      retryDelayMs: 25,
      customExecutor: async (_input, onEvent) => {
        attempts += 1;
        onEvent({
          type: 'failed',
          error: 'Simulated upstream error',
        });
      },
    });

    try {
      const started = await manager.startDownloadJob({
        ownerId: 'user-1',
        url: 'https://cdn.example.com/clip.mp4',
        platform: 'direct',
        platformName: 'Direct Media URL',
        mediaType: 'Video',
        targetFormat: 'mp4',
        autoRetry: false,
      });
      assert.equal(started.ok, true);
      if (!started.ok) return;

      const settled = await waitFor(() => {
        const res = manager.getJobForOwner(started.job.id, 'user-1');
        return res.ok && res.job.status === 'failed' ? res.job : null;
      });

      assert.equal(attempts, 1);
      assert.equal(settled.status, 'failed');
      assert.equal(settled.retryCount, 0);
      assert.equal(settled.maxRetries, 0);
    } finally {
      await manager.shutdown();
    }
  });

  it('retries failed jobs up to 3 times and sets status to permanently_failed when all retries fail', async () => {
    let attempts = 0;
    const manager = new MediaWorkerManager({
      tempDir: path.join(tempRoot, 'perm-fail'),
      disableAutoSweeper: true,
      retryDelayMs: 30,
      customExecutor: async (_input, onEvent) => {
        attempts += 1;
        onEvent({
          type: 'progress',
          status: 'processing',
          progressPercent: 25,
          bytesDownloaded: 128,
          totalBytes: 512,
          stageMessage: `Attempt ${attempts} running`,
        });
        onEvent({
          type: 'failed',
          error: `Attempt ${attempts} failed`,
        });
      },
    });

    try {
      const started = await manager.startDownloadJob({
        ownerId: 'user-2',
        url: 'https://cdn.example.com/broken.mp4',
        platform: 'direct',
        platformName: 'Direct Media URL',
        mediaType: 'Video',
        targetFormat: 'mp4',
        autoRetry: true,
      });
      assert.equal(started.ok, true);
      if (!started.ok) return;
      assert.equal(started.job.maxRetries, MAX_AUTO_RETRIES);

      const settled = await waitFor(() => {
        const res = manager.getJobForOwner(started.job.id, 'user-2');
        return res.ok && res.job.status === 'permanently_failed' ? res.job : null;
      });

      // 1 initial attempt + 3 automatic retries = 4 total attempts
      assert.equal(attempts, 4);
      assert.equal(settled.status, 'permanently_failed');
      assert.equal(settled.retryCount, 3);
      assert.equal(settled.maxRetries, 3);
      assert.match(settled.stageMessage, /permanently failed after 3 retry attempts/i);
    } finally {
      await manager.shutdown();
    }
  });

  it('recovers and completes when a transient failure succeeds on retry attempt 2', async () => {
    let attempts = 0;
    const workDir = path.join(tempRoot, 'recover');
    const manager = new MediaWorkerManager({
      tempDir: workDir,
      disableAutoSweeper: true,
      retryDelayMs: 30,
      customExecutor: async (input, onEvent) => {
        attempts += 1;
        if (attempts < 3) {
          onEvent({
            type: 'failed',
            error: `Transient error #${attempts}`,
          });
          return;
        }
        const jobDir = path.join(workDir, input.jobId);
        fs.mkdirSync(jobDir, { recursive: true });
        const outFile = path.join(jobDir, 'verified.mp4');
        fs.writeFileSync(outFile, Buffer.from('mp4-ok'));
        onEvent({
          type: 'completed',
          fileId: 'file-ok',
          filePath: outFile,
          verifiedMetadata: {
            mimeType: 'video/mp4',
            container: 'MP4',
            sizeBytes: 6,
          },
        });
      },
    });

    try {
      const started = await manager.startDownloadJob({
        ownerId: 'user-3',
        url: 'https://cdn.example.com/flaky.mp4',
        platform: 'direct',
        platformName: 'Direct Media URL',
        mediaType: 'Video',
        targetFormat: 'mp4',
        autoRetry: true,
      });
      assert.equal(started.ok, true);
      if (!started.ok) return;

      const settled = await waitFor(() => {
        const res = manager.getJobForOwner(started.job.id, 'user-3');
        return res.ok && res.job.status === 'completed' ? res.job : null;
      });

      assert.equal(attempts, 3);
      assert.equal(settled.status, 'completed');
      assert.equal(settled.retryCount, 2);
      assert.equal(settled.maxRetries, 3);
      assert.ok(settled.downloadToken);
    } finally {
      await manager.shutdown();
    }
  });

  it('stops pending retries cleanly when job is cancelled during retry backoff', async () => {
    let attempts = 0;
    const manager = new MediaWorkerManager({
      tempDir: path.join(tempRoot, 'cancel-retry'),
      disableAutoSweeper: true,
      retryDelayMs: 400,
      customExecutor: async (_input, onEvent) => {
        attempts += 1;
        onEvent({
          type: 'failed',
          error: 'First failure before cancel',
        });
      },
    });

    try {
      const started = await manager.startDownloadJob({
        ownerId: 'user-4',
        url: 'https://cdn.example.com/cancel-during-retry.mp4',
        platform: 'direct',
        platformName: 'Direct Media URL',
        mediaType: 'Video',
        targetFormat: 'mp4',
        autoRetry: true,
      });
      assert.equal(started.ok, true);
      if (!started.ok) return;

      await waitFor(() => {
        const res = manager.getJobForOwner(started.job.id, 'user-4');
        return res.ok && res.job.retryCount === 1 ? res.job : null;
      });

      const cancelRes = await manager.cancelOrDeleteJob(started.job.id, 'user-4');
      assert.equal(cancelRes.ok, true);
      if (!cancelRes.ok) return;
      assert.equal(cancelRes.job.status, 'cancelled');

      await new Promise((r) => setTimeout(r, 500));
      assert.equal(attempts, 1);
      const afterWait = manager.getJobForOwner(started.job.id, 'user-4');
      assert.equal(afterWait.ok, true);
      if (afterWait.ok) {
        assert.equal(afterWait.job.status, 'cancelled');
      }
    } finally {
      await manager.shutdown();
    }
  });

  it('persists autoRetry preference in PUT /api/preferences and applies it to POST /api/downloads', async () => {
    let attempts = 0;
    const manager = new MediaWorkerManager({
      tempDir: path.join(tempRoot, 'route-retry'),
      disableAutoSweeper: true,
      retryDelayMs: 25,
      customExecutor: async (_input, onEvent) => {
        attempts += 1;
        onEvent({
          type: 'failed',
          error: 'Persistent upstream failure',
        });
      },
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const mockUser: VerifiedFirebaseUser = {
      uid: 'uid-retry-route',
      email: 'retry@example.com',
      emailVerified: true,
      name: 'Retry Tester',
      picture: '',
      authTimeSeconds: nowSec,
      issuedAtSeconds: nowSec,
    };

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createMediaRouter({
        skipNetworkMetadata: true,
        workerManager: manager,
        tokenVerifier: async () => mockUser,
      })
    );

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const putRes = await fetch(`${baseUrl}/api/preferences`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ autoRetry: true }),
      });
      assert.equal(putRes.status, 200);
      const putJson = (await putRes.json()) as {
        preferences: { autoRetry: boolean };
      };
      assert.equal(putJson.preferences.autoRetry, true);

      // Omit autoRetry in POST /api/downloads so it picks up saved user preference
      const postRes = await fetch(`${baseUrl}/api/downloads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          url: 'https://cdn.example.com/assets/always-fail.mp4',
          targetFormat: 'mp4',
          userConfirmedPermission: true,
        }),
      });
      assert.equal(postRes.status, 202);
      const postJson = (await postRes.json()) as { job: { id: string; maxRetries?: number } };
      assert.equal(postJson.job.maxRetries, 3);

      const settled = await waitFor(async () => {
        const res = await fetch(`${baseUrl}/api/downloads/${postJson.job.id}`, {
          headers: { Authorization: 'Bearer test-token' },
        });
        const body = (await res.json()) as { job: { status: string; retryCount?: number } };
        return body.job.status === 'permanently_failed' ? body.job : null;
      });

      assert.equal(attempts, 4);
      assert.equal(settled.status, 'permanently_failed');
      assert.equal(settled.retryCount, 3);
    } finally {
      await manager.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});
