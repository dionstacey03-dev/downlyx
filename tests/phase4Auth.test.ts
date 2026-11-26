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
import { initializeApp as initializeClientApp, deleteApp as deleteClientApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  GoogleAuthProvider,
  sendEmailVerification,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { createMediaRouter } from '../server/routes/media.ts';
import {
  clearLocalRevocationWatermarksForTest,
  FirebaseTokenVerificationError,
  getFirebaseAdminApp,
  verifyFirebaseIdToken,
} from '../server/security/firebaseAdmin.ts';
import { MediaWorkerManager } from '../server/worker/mediaWorkerManager.ts';
import { executeWorkerJob } from '../server/worker/workerProcess.ts';
import {
  clearAuthEmulatorAccounts,
  ensureAuthEmulator,
  loadFirebaseAppletConfig,
  verifyLatestEmailOob,
  type EmulatorHandle,
} from './helpers/authEmulator.ts';

process.env.NODE_ENV = 'test';

let emulator: EmulatorHandle;
let server: http.Server;
let baseUrl = '';
let tempWorkDir = '';
let sampleMp4: Buffer;
let workerManagerRef: MediaWorkerManager;

function createMockMp4Stream(buf: Buffer): http.IncomingMessage {
  const stream = new Readable({ read() {} }) as unknown as http.IncomingMessage;
  stream.statusCode = 200;
  stream.headers = {
    'content-type': 'video/mp4',
    'content-length': String(buf.length),
  };
  setImmediate(() => {
    stream.push(buf);
    stream.push(null);
  });
  return stream;
}

describe('Phase 4: Firebase Authentication & User Isolation (Emulator Integration)', () => {
  const fbConfig = loadFirebaseAppletConfig();

  before(async () => {
    emulator = await ensureAuthEmulator(fbConfig.projectId);
    process.env.FIREBASE_AUTH_EMULATOR_HOST = emulator.hostPort;
    process.env.FIREBASE_PROJECT_ID = fbConfig.projectId;
    clearLocalRevocationWatermarksForTest();
    await clearAuthEmulatorAccounts(emulator.url, fbConfig.projectId);

    tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-p4-auth-'));
    const mp4Path = path.join(tempWorkDir, 'sample.mp4');
    const ff = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=0.4:size=160x120:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=0.4',
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
    if (ff.status !== 0) {
      throw new Error(`ffmpeg fixture failed: ${ff.stderr}`);
    }
    sampleMp4 = fs.readFileSync(mp4Path);

    const manager = new MediaWorkerManager({
      tempDir: path.join(tempWorkDir, 'worker'),
      disableAutoSweeper: true,
      customExecutor: async (input, onEvent, signal) => {
        await executeWorkerJob(input, onEvent, signal, {
          lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
          customStreamOpener: async () => createMockMp4Stream(sampleMp4),
        });
      },
    });
    // Expose manager reference for server-side ownership assertion
    workerManagerRef = manager;

    const app = express();
    app.use(express.json({ limit: '16kb' }));
    // Real Firebase Admin verification middleware (no mock tokenVerifier)
    app.use(
      '/api',
      createMediaRouter({
        skipNetworkMetadata: true,
        workerManager: manager,
        rateLimitMax: 200,
        downloadRateLimitMax: 200,
      })
    );

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await emulator?.stop();
    if (tempWorkDir && fs.existsSync(tempWorkDir)) {
      fs.rmSync(tempWorkDir, { recursive: true, force: true });
    }
  });

  function createIsolatedClient(name: string) {
    const clientApp = initializeClientApp(fbConfig, name);
    const clientAuth = getClientAuth(clientApp);
    connectAuthEmulator(clientAuth, emulator.url, { disableWarnings: true });
    return { clientApp, clientAuth };
  }

  it('rejects unauthenticated requests, invalid tokens, and deprecated /api/session', async () => {
    const legacySession = await fetch(`${baseUrl}/api/session`, { method: 'POST' });
    assert.equal(legacySession.status, 410);
    const legacyJson = (await legacySession.json()) as { code?: string };
    assert.equal(legacyJson.code, 'auth/session-migrated');

    const noTokenDl = await fetch(`${baseUrl}/api/downloads`);
    assert.equal(noTokenDl.status, 401);

    const badTokenDl = await fetch(`${baseUrl}/api/downloads`, {
      headers: { Authorization: 'Bearer not-a-real-jwt' },
    });
    assert.equal(badTokenDl.status, 401);

    // Crafted expired JWT should also be rejected by verifyFirebaseIdToken
    const expiredHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const expiredPayload = Buffer.from(
      JSON.stringify({
        iss: `https://securetoken.google.com/${fbConfig.projectId}`,
        aud: fbConfig.projectId,
        sub: 'uid-expired',
        exp: Math.floor(Date.now() / 1000) - 3600,
        iat: Math.floor(Date.now() / 1000) - 7200,
      })
    ).toString('base64url');
    await assert.rejects(
      () => verifyFirebaseIdToken(`${expiredHeader}.${expiredPayload}.`),
      (err: unknown) => err instanceof FirebaseTokenVerificationError && err.statusCode === 401
    );
  });

  it('enforces email verification on registration, then unlocks downloads and persistence after verifying', async () => {
    const { clientApp, clientAuth } = createIsolatedClient('client-reg-verify');
    try {
      const email = 'alice@example.com';
      const password = 'StrongPassword123!';
      const cred = await createUserWithEmailAndPassword(clientAuth, email, password);
      await updateProfile(cred.user, { displayName: 'Alice Test' });
      await sendEmailVerification(cred.user);

      const unverifiedToken = await cred.user.getIdToken();

      // /api/auth/me works so UI knows user state, but download/history/prefs require verified email
      const meRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${unverifiedToken}` },
      });
      assert.equal(meRes.status, 200);
      const meJson = (await meRes.json()) as { user: { uid: string; emailVerified: boolean } };
      assert.equal(meJson.user.uid, cred.user.uid);
      assert.equal(meJson.user.emailVerified, false);

      const unverifiedDl = await fetch(`${baseUrl}/api/downloads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${unverifiedToken}`,
        },
        body: JSON.stringify({
          url: 'https://cdn.example.com/clip.mp4',
          targetFormat: 'mp4',
          userConfirmedPermission: true,
        }),
      });
      assert.equal(unverifiedDl.status, 403);
      const unverifiedErr = (await unverifiedDl.json()) as { code?: string };
      assert.equal(unverifiedErr.code, 'auth/email-unverified');

      // Apply real Auth Emulator email verification OOB link
      await verifyLatestEmailOob(emulator.url, email, fbConfig.projectId);
      await cred.user.reload();
      assert.equal(cred.user.emailVerified, true);
      const verifiedToken = await cred.user.getIdToken(true);

      // Preferences and history now save cleanly per verified UID
      const putPrefs = await fetch(`${baseUrl}/api/preferences`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${verifiedToken}`,
        },
        body: JSON.stringify({
          defaultQuality: 'standard',
          defaultFormat: 'mp4',
          workspaceName: 'Alice Studio',
        }),
      });
      assert.equal(putPrefs.status, 200);

      const postHist = await fetch(`${baseUrl}/api/history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${verifiedToken}`,
        },
        body: JSON.stringify({
          url: 'https://cdn.example.com/alice-history.mp4',
          fileType: 'MP4',
          qualityPreference: 'Standard',
        }),
      });
      assert.equal(postHist.status, 201);

      // Sign out and log back in via signInWithEmailAndPassword -> history & prefs remain isolated & intact
      await signOut(clientAuth);
      const loginCred = await signInWithEmailAndPassword(clientAuth, email, password);
      const freshLoginToken = await loginCred.user.getIdToken();

      const getPrefs = await fetch(`${baseUrl}/api/preferences`, {
        headers: { Authorization: `Bearer ${freshLoginToken}` },
      });
      assert.equal(getPrefs.status, 200);
      const prefsBody = (await getPrefs.json()) as { preferences: { workspaceName: string } };
      assert.equal(prefsBody.preferences.workspaceName, 'Alice Studio');

      const getHist = await fetch(`${baseUrl}/api/history`, {
        headers: { Authorization: `Bearer ${freshLoginToken}` },
      });
      const histBody = (await getHist.json()) as { items: Array<{ url: string }> };
      assert.equal(histBody.items.length, 1);
      assert.equal(histBody.items[0].url, 'https://cdn.example.com/alice-history.mp4');
    } finally {
      await deleteClientApp(clientApp);
    }
  });

  it('supports Google OAuth credential flow, ignores spoofed ownerId, and blocks cross-user job access', async () => {
    const clientA = createIsolatedClient('client-a-isolation');
    const clientB = createIsolatedClient('client-b-google');
    try {
      const credA = await signInWithEmailAndPassword(
        clientA.clientAuth,
        'alice@example.com',
        'StrongPassword123!'
      );
      const tokenA = await credA.user.getIdToken();

      // Simulate Google OAuth sign-in against Firebase Auth Emulator
      const googleIdToken = JSON.stringify({
        sub: 'google-oauth-user-bob-123',
        email: 'bob.google@example.com',
        email_verified: true,
        name: 'Bob Google',
      });
      const credB = await signInWithCredential(
        clientB.clientAuth,
        GoogleAuthProvider.credential(googleIdToken)
      );
      const tokenB = await credB.user.getIdToken();
      assert.notEqual(credA.user.uid, credB.user.uid);

      // Client tries spoofing ownerId = credB.user.uid in request body; server must derive UID from tokenA
      const startRes = await fetch(`${baseUrl}/api/downloads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          ownerId: credB.user.uid,
          url: 'https://cdn.example.com/alice-video.mp4',
          targetFormat: 'mp4',
          userConfirmedPermission: true,
        }),
      });
      assert.equal(startRes.status, 202);
      const { job } = (await startRes.json()) as {
        job: { id: string; status: string };
      };
      // Server strips ownerId from JSON DTO and binds ownership strictly to credA.user.uid
      assert.equal(
        'ownerId' in job,
        false,
        'Public DownloadJob JSON DTO must not leak internal ownerId'
      );
      assert.equal(workerManagerRef.getJobForOwner(job.id, credA.user.uid).ok, true);

      // Cross-user access checks: Bob cannot view, tokenize, cancel, or download Alice's job
      const bobGetJob = await fetch(`${baseUrl}/api/downloads/${job.id}`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.equal(bobGetJob.status, 403);

      const bobTokenRes = await fetch(`${baseUrl}/api/downloads/${job.id}/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.equal(bobTokenRes.status, 403);

      const bobDelRes = await fetch(`${baseUrl}/api/downloads/${job.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.equal(bobDelRes.status, 403);

      const bobListRes = await fetch(`${baseUrl}/api/downloads`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.equal(bobListRes.status, 200);
      const bobJobs = (await bobListRes.json()) as { jobs: unknown[] };
      assert.equal(bobJobs.jobs.length, 0);
    } finally {
      await deleteClientApp(clientA.clientApp);
      await deleteClientApp(clientB.clientApp);
    }
  });

  it('rejects revoked tokens after logout and Admin revokeRefreshTokens, and cleanly purges data on account deletion', async () => {
    const client = createIsolatedClient('client-revoke-delete');
    try {
      const email = 'charlie@example.com';
      const password = 'CharliePassword123!';
      const cred = await createUserWithEmailAndPassword(client.clientAuth, email, password);
      await sendEmailVerification(cred.user);
      await verifyLatestEmailOob(emulator.url, email, fbConfig.projectId);
      await cred.user.reload();

      const token1 = await cred.user.getIdToken(true);

      // Create a history item and download job for Charlie
      await fetch(`${baseUrl}/api/downloads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token1}`,
        },
        body: JSON.stringify({
          url: 'https://cdn.example.com/charlie-clip.mp4',
          targetFormat: 'mp4',
          userConfirmedPermission: true,
        }),
      });

      // Logout revokes the token immediately on backend
      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token1}` },
      });
      assert.equal(logoutRes.status, 200);

      const reuseLoggedOutToken = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token1}` },
      });
      assert.equal(reuseLoggedOutToken.status, 401);
      const reuseErr = (await reuseLoggedOutToken.json()) as { code?: string };
      assert.equal(reuseErr.code, 'auth/id-token-revoked');

      // Fresh login in next second window succeeds, then Admin revokeRefreshTokens also blocks prior token
      await new Promise((r) => setTimeout(r, 1100));
      const relogin = await signInWithEmailAndPassword(client.clientAuth, email, password);
      const token2 = await relogin.user.getIdToken(true);
      const meOk = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token2}` },
      });
      assert.equal(meOk.status, 200);

      // Wait past the 1-second tokensValidAfterTime boundary before revoking via Admin SDK
      await new Promise((r) => setTimeout(r, 1100));
      await getAdminAuth(getFirebaseAdminApp()).revokeRefreshTokens(relogin.user.uid);
      const afterAdminRevoke = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token2}` },
      });
      assert.equal(afterAdminRevoke.status, 401);

      // Re-sign in and test full account deletion
      const beforeDeleteLogin = await signInWithEmailAndPassword(
        client.clientAuth,
        email,
        password
      );
      const deleteToken = await beforeDeleteLogin.user.getIdToken(true);

      const delAccRes = await fetch(`${baseUrl}/api/account`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${deleteToken}` },
      });
      assert.equal(delAccRes.status, 200);
      const delAccBody = (await delAccRes.json()) as {
        deleted: boolean;
        purgedJobsCount: number;
      };
      assert.equal(delAccBody.deleted, true);
      assert.ok(delAccBody.purgedJobsCount >= 1);

      // The DELETE /api/account endpoint already deletes the Firebase Auth user.
      // Calling client deleteUser() again uses a revoked/expired token and fails.

      // Deleted user token can no longer access backend endpoints
      const postDeleteMe = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${deleteToken}` },
      });
      assert.equal(postDeleteMe.status, 401);
    } finally {
      await deleteClientApp(client.clientApp);
    }
  });

  it('batch-deletes only the authenticated user’s selected history items via POST /api/history/batch-delete', async () => {
    const clientA = createIsolatedClient('client-batch-a');
    const clientB = createIsolatedClient('client-batch-b');
    try {
      const emailA = 'batch-a@example.com';
      const emailB = 'batch-b@example.com';
      const pass = 'BatchSecret123!';

      const credA = await createUserWithEmailAndPassword(clientA.clientAuth, emailA, pass);
      await sendEmailVerification(credA.user);
      await verifyLatestEmailOob(emulator.url, emailA, fbConfig.projectId);
      await credA.user.reload();
      const tokenA = await credA.user.getIdToken(true);

      const credB = await createUserWithEmailAndPassword(clientB.clientAuth, emailB, pass);
      await sendEmailVerification(credB.user);
      await verifyLatestEmailOob(emulator.url, emailB, fbConfig.projectId);
      await credB.user.reload();
      const tokenB = await credB.user.getIdToken(true);

      const postItem = async (token: string, url: string) => {
        const res = await fetch(`${baseUrl}/api/history`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ url }),
        });
        assert.equal(res.status, 201);
        const body = (await res.json()) as { item: { id: string } };
        return body.item.id;
      };

      const a1 = await postItem(tokenA, 'https://cdn.example.com/a1.mp4');
      const a2 = await postItem(tokenA, 'https://cdn.example.com/a2.mp4');
      const a3 = await postItem(tokenA, 'https://cdn.example.com/a3.mp4');
      const b1 = await postItem(tokenB, 'https://cdn.example.com/b1.mp4');

      // Empty array is rejected
      const badReq = await fetch(`${baseUrl}/api/history/batch-delete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ ids: [] }),
      });
      assert.equal(badReq.status, 400);

      // User A deletes a1, a3, and attempts to include User B's b1 -> only a1 & a3 deleted
      const batchRes = await fetch(`${baseUrl}/api/history/batch-delete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ ids: [a1, a3, b1] }),
      });
      assert.equal(batchRes.status, 200);
      const batchJson = (await batchRes.json()) as {
        deletedIds: string[];
        deletedCount: number;
      };
      assert.equal(batchJson.deletedCount, 2);
      assert.deepEqual(batchJson.deletedIds.sort(), [a1, a3].sort());

      const listA = await fetch(`${baseUrl}/api/history`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const itemsA = ((await listA.json()) as { items: { id: string }[] }).items;
      assert.deepEqual(
        itemsA.map((i) => i.id),
        [a2]
      );

      // User B's history item b1 remains untouched
      const listB = await fetch(`${baseUrl}/api/history`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      const itemsB = ((await listB.json()) as { items: { id: string }[] }).items;
      assert.deepEqual(
        itemsB.map((i) => i.id),
        [b1]
      );
    } finally {
      await deleteClientApp(clientA.clientApp);
      await deleteClientApp(clientB.clientApp);
    }
  });
});
