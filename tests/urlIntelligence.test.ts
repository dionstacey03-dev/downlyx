import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { analyzeUrlIntelligence } from '../server/services/urlIntelligenceService.ts';
import {
  isPrivateOrReservedIp,
  validateRedirectDestination,
} from '../server/security/urlSecurity.ts';
import { createMediaRouter } from '../server/routes/media.ts';
import type { AnalyzeResponse } from '../src/types/media.ts';

process.env.NODE_ENV = 'test';

async function withTestServer(
  opts: { rateLimitMax?: number; rateLimitWindowMs?: number },
  fn: (baseUrl: string) => Promise<void>
) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(
    '/api',
    createMediaRouter({
      rateLimitMax: opts.rateLimitMax ?? 50,
      rateLimitWindowMs: opts.rateLimitWindowMs ?? 60_000,
      skipNetworkMetadata: true,
    })
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

describe('DOWNLYX Phase 2: URL Intelligence Engine', () => {
  it('accepts valid YouTube watch URLs and keeps downloads disabled without approval', async () => {
    const res = await analyzeUrlIntelligence(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      { skipNetworkMetadata: true }
    );
    assert.equal(res.httpStatus, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.platform, 'youtube');
    assert.equal(res.payload.mediaType, 'Video');
    assert.equal(res.payload.resourceId, 'dQw4w9WgXcQ');
    assert.equal(res.payload.validationStatus, 'valid');
    assert.equal(res.payload.capabilities.urlDetection, 'supported');
    assert.equal(res.payload.capabilities.authorizedMediaRetrieval, 'restricted');
    assert.equal(res.payload.capabilities.actualDownloadAvailability, 'not_available');
    assert.deepEqual(res.payload.availableFormats, []);
    assert.deepEqual(res.payload.qualityOptions, []);
  });

  it('recognizes YouTube Shorts URLs and extracts Shorts ID', async () => {
    const res = await analyzeUrlIntelligence(
      'https://www.youtube.com/shorts/abcDEF12345',
      { skipNetworkMetadata: true }
    );
    assert.equal(res.httpStatus, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.platform, 'youtube');
    assert.equal(res.payload.mediaType, 'Short Video');
    assert.equal(res.payload.resourceId, 'abcDEF12345');
  });

  it('recognizes Instagram Reels and marks retrieval as requires_authorization', async () => {
    const res = await analyzeUrlIntelligence(
      'https://www.instagram.com/reel/C8xYz9AbCdE/',
      { skipNetworkMetadata: true }
    );
    assert.equal(res.httpStatus, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.platform, 'instagram');
    assert.equal(res.payload.mediaType, 'Reel');
    assert.equal(res.payload.resourceId, 'C8xYz9AbCdE');
    assert.equal(res.payload.metadataStatus, 'requires_authorization');
    assert.equal(
      res.payload.capabilities.authorizedMediaRetrieval,
      'requires_authorization'
    );
    assert.deepEqual(res.payload.availableFormats, []);
  });

  it('detects Instagram Stories URLs while strictly restricting access', async () => {
    const res = await analyzeUrlIntelligence(
      'https://www.instagram.com/stories/exampleuser/341234567890/',
      { skipNetworkMetadata: true }
    );
    assert.equal(res.httpStatus, 200);
    assert.equal(res.payload.success, false);
    assert.equal(res.payload.platform, 'instagram');
    assert.equal(res.payload.mediaType, 'Story');
    assert.equal(res.payload.validationStatus, 'unsupported');
    assert.equal(res.payload.capabilities.urlDetection, 'supported');
    assert.equal(res.payload.capabilities.metadataAvailability, 'restricted');
    assert.equal(res.payload.capabilities.authorizedMediaRetrieval, 'restricted');
    assert.equal(res.payload.capabilities.actualDownloadAvailability, 'not_available');
    assert.equal(res.payload.metadataStatus, 'restricted');
    assert.deepEqual(res.payload.qualityOptions, []);
  });

  it('recognizes TikTok canonical and short links safely', async () => {
    const canonical = await analyzeUrlIntelligence(
      'https://www.tiktok.com/@creator/video/7349182736451234567',
      { skipNetworkMetadata: true }
    );
    assert.equal(canonical.payload.success, true);
    assert.equal(canonical.payload.platform, 'tiktok');
    assert.equal(canonical.payload.mediaType, 'Short Video');
    assert.equal(canonical.payload.resourceId, '7349182736451234567');

    const shortLink = await analyzeUrlIntelligence(
      'https://vm.tiktok.com/ZM6abc123/',
      { skipNetworkMetadata: true }
    );
    assert.equal(shortLink.payload.success, true);
    assert.equal(shortLink.payload.platform, 'tiktok');
    assert.equal(shortLink.payload.resourceId, 'ZM6abc123');
  });

  it('recognizes Facebook Watch and Reel links', async () => {
    const watch = await analyzeUrlIntelligence(
      'https://www.facebook.com/watch/?v=10153231379946729',
      { skipNetworkMetadata: true }
    );
    assert.equal(watch.payload.success, true);
    assert.equal(watch.payload.platform, 'facebook');
    assert.equal(watch.payload.mediaType, 'Video');
    assert.equal(watch.payload.resourceId, '10153231379946729');

    const reel = await analyzeUrlIntelligence(
      'https://www.facebook.com/reel/987654321098765',
      { skipNetworkMetadata: true }
    );
    assert.equal(reel.payload.success, true);
    assert.equal(reel.payload.mediaType, 'Reel');
    assert.equal(reel.payload.resourceId, '987654321098765');
  });

  it('recognizes X / Twitter post status links', async () => {
    const res = await analyzeUrlIntelligence(
      'https://x.com/nasa/status/1841234567890123456',
      { skipNetworkMetadata: true }
    );
    assert.equal(res.httpStatus, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.platform, 'x');
    assert.equal(res.payload.mediaType, 'Post Media');
    assert.equal(res.payload.resourceId, '1841234567890123456');
  });

  it('classifies Direct MP4 and MP3 URLs as probable_media_url with permitted output formats', async () => {
    const mp4 = await analyzeUrlIntelligence(
      'https://cdn.example.com/videos/clip-1080.mp4',
      { skipNetworkMetadata: true }
    );
    assert.equal(mp4.payload.success, true);
    assert.equal(mp4.payload.platform, 'direct');
    assert.equal(mp4.payload.mediaType, 'Video');
    assert.deepEqual(mp4.payload.availableFormats, []);
    assert.deepEqual(mp4.payload.qualityOptions, []);
    assert.ok(mp4.payload.permittedOutputFormats?.includes('MP4'));
    assert.ok(mp4.payload.permittedOutputFormats?.includes('MP3'));
    assert.equal(mp4.payload.directMediaVerification?.classification, 'probable_media_url');
    assert.equal(mp4.payload.directMediaVerification?.expectedContainer, 'MP4');
    assert.equal(mp4.payload.directMediaVerification?.signatureVerified, false);
    assert.equal(mp4.payload.capabilities.actualDownloadAvailability, 'supported');

    const mp3 = await analyzeUrlIntelligence(
      'https://cdn.example.com/audio/track.mp3',
      { skipNetworkMetadata: true }
    );
    assert.equal(mp3.payload.success, true);
    assert.equal(mp3.payload.mediaType, 'Audio');
    assert.ok(mp3.payload.permittedOutputFormats?.includes('MP3'));
    assert.equal(mp3.payload.directMediaVerification?.classification, 'probable_media_url');
    assert.equal(mp3.payload.directMediaVerification?.expectedContainer, 'MP3');
    assert.equal(mp3.payload.directMediaVerification?.signatureVerified, false);
  });

  it('rejects missing protocols and invalid URLs', async () => {
    const missingProto = await analyzeUrlIntelligence(
      'youtube.com/watch?v=dQw4w9WgXcQ',
      { skipNetworkMetadata: true }
    );
    assert.equal(missingProto.httpStatus, 400);
    assert.equal(missingProto.payload.success, false);
    assert.equal(missingProto.payload.validationStatus, 'invalid');
    assert.match(missingProto.payload.error ?? '', /https:\/\//i);

    const empty = await analyzeUrlIntelligence('   ', {
      skipNetworkMetadata: true,
    });
    assert.equal(empty.httpStatus, 400);
    assert.equal(empty.payload.validationStatus, 'invalid');
  });

  it('rejects unsupported domains without claiming download capability', async () => {
    const res = await analyzeUrlIntelligence(
      'https://unsupported-streaming.example.org/watch/12345',
      { skipNetworkMetadata: true }
    );
    assert.equal(res.httpStatus, 200);
    assert.equal(res.payload.success, false);
    assert.equal(res.payload.platform, 'unsupported');
    assert.equal(res.payload.validationStatus, 'unsupported');
    assert.equal(res.payload.capabilities.actualDownloadAvailability, 'not_available');
  });

  it('blocks HTTP non-TLS and unsupported schemes', async () => {
    for (const url of [
      'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://cdn.example.com/video.mp4',
    ]) {
      const res = await analyzeUrlIntelligence(url, {
        skipNetworkMetadata: true,
      });
      assert.equal(res.httpStatus, 400, `Expected 400 for ${url}`);
      assert.equal(res.payload.validationStatus, 'blocked');
    }
  });

  it('blocks localhost, private IPs, metadata endpoints, and IP-literal bypasses', async () => {
    const blockedTargets = [
      'https://localhost/video.mp4',
      'https://sub.localhost/video.mp4',
      'https://127.0.0.1/video.mp4',
      'https://10.0.0.5/video.mp4',
      'https://172.16.0.1/video.mp4',
      'https://192.168.1.10/video.mp4',
      'https://169.254.169.254/latest/meta-data/',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://[::1]/video.mp4',
      'https://[::ffff:127.0.0.1]/video.mp4',
      'https://2130706433/video.mp4',
      'https://0x7f000001/video.mp4',
      'https://0177.0.0.1/video.mp4',
      'https://127.1/video.mp4',
    ];

    for (const url of blockedTargets) {
      const res = await analyzeUrlIntelligence(url, {
        skipNetworkMetadata: true,
      });
      assert.equal(res.httpStatus, 400, `Expected 400 for ${url}`);
      assert.equal(res.payload.success, false);
      assert.equal(res.payload.validationStatus, 'blocked');
    }

    assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
    assert.equal(isPrivateOrReservedIp('::ffff:10.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
  });

  it('blocks redirect attacks and validates outbound redirect destinations', async () => {
    const redirectAttackUrls = [
      'https://www.youtube.com/redirect?q=http%3A%2F%2F127.0.0.1%2Fadmin',
      'https://cdn.example.com/out/?url=https://169.254.169.254/latest/meta-data',
      'https://cdn.example.com/go/?next=https://localhost:3000/secret',
      'https://www.facebook.com/l.php?u=javascript:alert(1)',
    ];

    for (const url of redirectAttackUrls) {
      const res = await analyzeUrlIntelligence(url, {
        skipNetworkMetadata: true,
      });
      assert.equal(res.httpStatus, 400, `Expected 400 for redirect attack ${url}`);
      assert.equal(res.payload.validationStatus, 'blocked');
    }

    const allowlist = new Set(['www.youtube.com']);
    assert.equal(
      validateRedirectDestination('https://127.0.0.1/oembed', allowlist).safe,
      false
    );
    assert.equal(
      validateRedirectDestination('https://evil.example.com/oembed', allowlist).safe,
      false
    );
    assert.equal(
      validateRedirectDestination('https://www.youtube.com/oembed', allowlist).safe,
      true
    );
  });

  it('blocks malformed and deceptive URLs (embedded credentials, backslashes, non-443 ports)', async () => {
    const deceptiveUrls = [
      'https://youtube.com@127.0.0.1/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com\\@evil.com/watch?v=123',
      'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
      'https://',
      'not a url at all',
    ];

    for (const url of deceptiveUrls) {
      const res = await analyzeUrlIntelligence(url, {
        skipNetworkMetadata: true,
      });
      assert.equal(res.httpStatus, 400, `Expected 400 for deceptive URL ${url}`);
      assert.equal(res.payload.success, false);
    }
  });

  it('serves POST /api/analyze over HTTP and enforces rate limiting (429)', async () => {
    await withTestServer({ rateLimitMax: 2, rateLimitWindowMs: 60_000 }, async (baseUrl) => {
      const r1 = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.com/nasa/status/1841234567890123456' }),
      });
      assert.equal(r1.status, 200);
      const body1 = (await r1.json()) as AnalyzeResponse;
      assert.equal(body1.success, true);
      assert.equal(body1.platform, 'x');

      const r2 = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://127.0.0.1/bad.mp4' }),
      });
      assert.equal(r2.status, 400);

      const r3 = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.com/nasa/status/1841234567890123456' }),
      });
      assert.equal(r3.status, 429);
      const body3 = (await r3.json()) as AnalyzeResponse;
      assert.equal(body3.success, false);
      assert.equal(body3.validationStatus, 'blocked');
    });
  });
});
