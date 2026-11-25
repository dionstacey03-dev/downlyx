import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSessionSecretConfigured,
  createSignedDownloadToken,
  issueWorkspaceSessionToken,
  verifySignedDownloadToken,
  verifyWorkspaceSessionToken,
} from '../server/security/sessionAuth.ts';

describe('session and download token security', () => {
  it('requires a stable 32-byte signing secret in production', () => {
    const previousMode = process.env.NODE_ENV;
    const previousSecret = process.env.DOWNLYX_SESSION_SECRET;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.DOWNLYX_SESSION_SECRET;
      assert.throws(() => assertSessionSecretConfigured(), /at least 32 bytes/);
      process.env.DOWNLYX_SESSION_SECRET = 'short';
      assert.throws(() => assertSessionSecretConfigured(), /at least 32 bytes/);
      process.env.DOWNLYX_SESSION_SECRET = 'x'.repeat(32);
      assert.doesNotThrow(() => assertSessionSecretConfigured());
    } finally {
      if (previousMode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousMode;
      if (previousSecret === undefined) delete process.env.DOWNLYX_SESSION_SECRET;
      else process.env.DOWNLYX_SESSION_SECRET = previousSecret;
    }
  });

  it('validates workspace session claims and expiry bounds', () => {
    assert.throws(() => issueWorkspaceSessionToken('', 1000), /ownerId/);
    assert.throws(() => issueWorkspaceSessionToken('user-1', 25 * 60 * 60 * 1000), /TTL/);
    const issued = issueWorkspaceSessionToken('user-1', 60_000);
    const verified = verifyWorkspaceSessionToken(issued.token);
    assert.equal(verified?.ownerId, 'user-1');
    assert.equal(verifyWorkspaceSessionToken('x'.repeat(5000)), null);
  });

  it('consumes signed download tokens once and validates their lifetime', () => {
    const issued = createSignedDownloadToken({
      jobId: 'job-123',
      ownerId: 'user-123',
      fileId: 'file-123',
      ttlMs: 60_000,
    });
    const first = verifySignedDownloadToken(issued.token, 'job-123');
    assert.equal(first?.ownerId, 'user-123');
    assert.equal(verifySignedDownloadToken(issued.token, 'job-123'), null);
    assert.equal(verifySignedDownloadToken(issued.token, 'another-job', { consume: false }), null);
    assert.throws(
      () => createSignedDownloadToken({
        jobId: 'job-123',
        ownerId: 'user-123',
        fileId: 'file-123',
        ttlMs: 16 * 60 * 1000,
      }),
      /TTL/
    );
  });
});
