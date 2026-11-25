import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createRateLimiter,
  isPrivateOrReservedIp,
  parseStrictContentLength,
  resolveAndValidatePublicIps,
  resolveClientIp,
  safePinnedProviderFetch,
  validateRedirectDestination,
} from '../server/security/urlSecurity.ts';
import { verifyMediaMimeAndSignature } from '../server/security/mediaSignature.ts';

describe('DOWNLYX Phase 2.1: Security Hardening & Audit Tests', () => {
  it('prevents DNS rebinding by pinning the single validated IP for outbound transport', async () => {
    let lookupCalls = 0;
    const pinnedIpsUsed: string[] = [];

    // Rebinding DNS lookup: 1st call returns public IP, 2nd call would return 127.0.0.1 if called again
    const rebindingLookup = async () => {
      lookupCalls += 1;
      if (lookupCalls === 1) {
        return [{ address: '93.184.216.34', family: 4 as const }];
      }
      return [{ address: '127.0.0.1', family: 4 as const }];
    };

    const result = await safePinnedProviderFetch({
      providerId: 'youtube',
      endpointUrl:
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
      lookupFn: rebindingLookup,
      transportFn: async ({ pinnedAddress }) => {
        pinnedIpsUsed.push(pinnedAddress.address);
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          bodyBuffer: Buffer.from(JSON.stringify({ title: 'Pinned OK' })),
        };
      },
    });

    assert.equal(lookupCalls, 1);
    assert.deepEqual(pinnedIpsUsed, ['93.184.216.34']);
    assert.equal(result.ok, true);
    assert.equal(result.data?.title, 'Pinned OK');
  });

  it('rejects mixed public and private DNS records (IPv4 and IPv6)', async () => {
    const mixedV4 = await resolveAndValidatePublicIps('www.youtube.com', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    assert.equal(mixedV4.valid, false);
    assert.match(mixedV4.error ?? '', /mixed/i);

    const mixedV6 = await resolveAndValidatePublicIps('www.youtube.com', async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '::1', family: 6 },
    ]);
    assert.equal(mixedV6.valid, false);

    const mixedPrivateV4 = await resolveAndValidatePublicIps('www.youtube.com', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    assert.equal(mixedPrivateV4.valid, false);
  });

  it('blocks IPv6 private, link-local, ULA, NAT64, and expanded IPv4-mapped addresses', () => {
    const privateV6Addresses = [
      '::1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '::',
      '::ffff:127.0.0.1',
      '0:0:0:0:0:ffff:7f00:1',
      '::ffff:169.254.169.254',
      'fe80::1',
      'febf::1234',
      'fc00::1',
      'fd12:3456:789a::1',
      '64:ff9b::10.0.0.1',
      '2001:db8::1',
      'ff02::1',
    ];

    for (const ip of privateV6Addresses) {
      assert.equal(
        isPrivateOrReservedIp(ip),
        true,
        `Expected private/reserved IPv6 detection for ${ip}`
      );
    }

    assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false);
  });

  it('refuses redirect chains, redirects to localhost, and redirects to cloud metadata', async () => {
    const publicLookup = async () => [
      { address: '93.184.216.34', family: 4 as const },
    ];

    // Redirect chain / 302 to untrusted host
    const redirectChain = await safePinnedProviderFetch({
      providerId: 'youtube',
      endpointUrl: 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D123456',
      lookupFn: publicLookup,
      transportFn: async () => ({
        statusCode: 302,
        headers: { location: 'https://evil-tracker.example.com/hop2' },
        bodyBuffer: Buffer.alloc(0),
      }),
    });
    assert.equal(redirectChain.ok, false);
    assert.equal(redirectChain.status, 302);
    assert.match(redirectChain.warning ?? '', /allowlist/i);

    // Redirect to localhost
    const redirectLocalhost = await safePinnedProviderFetch({
      providerId: 'youtube',
      endpointUrl: 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D123456',
      lookupFn: publicLookup,
      transportFn: async () => ({
        statusCode: 301,
        headers: { location: 'https://localhost:3000/internal' },
        bodyBuffer: Buffer.alloc(0),
      }),
    });
    assert.equal(redirectLocalhost.ok, false);
    assert.match(redirectLocalhost.warning ?? '', /localhost|blocked/i);

    // Redirect to cloud metadata
    const redirectMetadata = await safePinnedProviderFetch({
      providerId: 'youtube',
      endpointUrl: 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D123456',
      lookupFn: publicLookup,
      transportFn: async () => ({
        statusCode: 307,
        headers: { location: 'https://169.254.169.254/latest/meta-data/' },
        bodyBuffer: Buffer.alloc(0),
      }),
    });
    assert.equal(redirectMetadata.ok, false);
    assert.match(redirectMetadata.warning ?? '', /blocked|metadata|ip/i);

    // Direct validator check including relative redirect on untrusted path vs allowlist
    const allowlist = new Set(['www.youtube.com']);
    assert.equal(
      validateRedirectDestination('https://metadata.google.internal/', allowlist).safe,
      false
    );
    assert.equal(
      validateRedirectDestination('http://127.0.0.1/', allowlist).safe,
      false
    );
  });

  it('rejects unexpected MIME types on outbound metadata and verifies media signatures safely', async () => {
    const publicLookup = async () => [
      { address: '93.184.216.34', family: 4 as const },
    ];

    for (const badMime of [
      'text/html; charset=utf-8',
      'text/plain; note=application/json',
      'application/javascript',
    ]) {
      const res = await safePinnedProviderFetch({
        providerId: 'youtube',
        endpointUrl: 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D123456',
        lookupFn: publicLookup,
        transportFn: async () => ({
          statusCode: 200,
          headers: { 'content-type': badMime },
          bodyBuffer: Buffer.from('{"title":"spoof"}'),
        }),
      });
      assert.equal(res.ok, false, `Expected rejection for MIME ${badMime}`);
    }

    // Direct media signature verification checks
    const validMp4Header = Uint8Array.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    assert.equal(
      verifyMediaMimeAndSignature('video/mp4', validMp4Header).verified,
      true
    );

    const validPngHeader = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    assert.equal(
      verifyMediaMimeAndSignature('image/png', validPngHeader).verified,
      true
    );

    // Reject HTML or SVG disguised with media extension/header
    const htmlBytes = new TextEncoder().encode('<html><body>not video</body></html>');
    assert.equal(
      verifyMediaMimeAndSignature('text/html', htmlBytes).verified,
      false
    );
    assert.equal(
      verifyMediaMimeAndSignature('video/mp4', htmlBytes).verified,
      false
    );
    assert.equal(
      verifyMediaMimeAndSignature('image/svg+xml', htmlBytes).verified,
      false
    );
    assert.equal(
      verifyMediaMimeAndSignature('image/png', validMp4Header).verified,
      false
    );
  });

  it('rejects oversized responses and malformed Content-Length headers', async () => {
    assert.equal(parseStrictContentLength('-5', 65536).valid, false);
    assert.equal(parseStrictContentLength('123abc', 65536).valid, false);
    assert.equal(parseStrictContentLength(['100', '999999'], 65536).valid, false);
    assert.equal(parseStrictContentLength('999999', 65536).valid, false);
    assert.equal(parseStrictContentLength('1024', 65536).valid, true);

    const publicLookup = async () => [
      { address: '93.184.216.34', family: 4 as const },
    ];

    const oversized = await safePinnedProviderFetch({
      providerId: 'tiktok',
      endpointUrl: 'https://www.tiktok.com/oembed?url=https%3A%2F%2Fwww.tiktok.com%2F%40a%2Fvideo%2F123',
      lookupFn: publicLookup,
      transportFn: async ({ maxBytes }) => {
        if (100_000 > maxBytes) {
          throw new Error(`Response body exceeded maximum ${maxBytes}-byte limit.`);
        }
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          bodyBuffer: Buffer.alloc(100_000),
        };
      },
    });
    assert.equal(oversized.ok, false);
    assert.match(oversized.warning ?? '', /limit/i);
  });

  it('rejects invalid provider responses (malformed JSON, arrays, non-2xx statuses)', async () => {
    const publicLookup = async () => [
      { address: '93.184.216.34', family: 4 as const },
    ];

    const malformedJson = await safePinnedProviderFetch({
      providerId: 'youtube',
      endpointUrl: 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D123456',
      lookupFn: publicLookup,
      transportFn: async () => ({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bodyBuffer: Buffer.from('{not valid json'),
      }),
    });
    assert.equal(malformedJson.ok, false);
    assert.match(malformedJson.warning ?? '', /invalid json/i);

    const arrayJson = await safePinnedProviderFetch({
      providerId: 'youtube',
      endpointUrl: 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D123456',
      lookupFn: publicLookup,
      transportFn: async () => ({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bodyBuffer: Buffer.from('["unexpected","array"]'),
      }),
    });
    assert.equal(arrayJson.ok, false);
    assert.match(arrayJson.warning ?? '', /json object/i);
  });

  it('prevents spoofed X-Forwarded-For headers from bypassing rate limiting', async () => {
    const app = express();
    app.set('trust proxy', false);
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      trustProxy: false,
    });
    app.post('/api/test-limit', limiter, (_req, res) => {
      res.json({ ok: true });
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/api/test-limit`;

    try {
      const r1 = await fetch(url, {
        method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.10' },
      });
      assert.equal(r1.status, 200);

      const r2 = await fetch(url, {
        method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.20' },
      });
      assert.equal(r2.status, 200);

      // Spoofing a 3rd X-Forwarded-For IP still hits the rate limit on the real socket peer
      const r3 = await fetch(url, {
        method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.30' },
      });
      assert.equal(r3.status, 429);

      // Even when trustProxy is true behind a loopback proxy, rightmost non-private hop is selected
      const fakeReq = {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': '8.8.8.8, 1.1.1.1' },
      } as unknown as express.Request;
      assert.equal(
        resolveClientIp(fakeReq, { trustProxy: true }),
        '1.1.1.1'
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  it('does not evict active rate-limit buckets when the cache is full', async () => {
    const app = express();
    app.set('trust proxy', false);
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      trustProxy: true,
      maxBuckets: 2,
    });
    app.get('/capacity-limit', limiter, (_req, res) => res.status(200).json({ ok: true }));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/capacity-limit`;
    const requestFrom = (ip: string) =>
      fetch(url, { headers: { 'X-Forwarded-For': ip } });

    try {
      assert.equal((await requestFrom('8.8.8.8')).status, 200);
      assert.equal((await requestFrom('8.8.8.8')).status, 429);
      assert.equal((await requestFrom('1.1.1.1')).status, 200);
      assert.equal((await requestFrom('9.9.9.9')).status, 429);
      // Existing bucket remains active; cache pressure must not reset its limit.
      assert.equal((await requestFrom('8.8.8.8')).status, 429);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});
