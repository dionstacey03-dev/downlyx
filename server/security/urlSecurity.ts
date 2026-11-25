import dns from 'dns/promises';
import https from 'https';
import net from 'net';
import type { NextFunction, Request, Response } from 'express';
import {
  isRestrictedHostname,
  validateExternalHttpsUrl,
} from '../../src/utils/platformDetector.ts';

export type MetadataProviderId = 'youtube' | 'tiktok';

// Locked security policy constants — provider adapters cannot override these.
const METADATA_ENDPOINT_ALLOWLIST: Record<MetadataProviderId, ReadonlySet<string>> = {
  youtube: new Set(['www.youtube.com']),
  tiktok: new Set(['www.tiktok.com']),
};

const HARD_TIMEOUT_MS = 3500;
const HARD_MAX_RESPONSE_BYTES = 64 * 1024; // 64 KB ceiling for metadata JSON

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsLookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export type TransportRequestFn = (params: {
  url: URL;
  pinnedAddress: ResolvedAddress;
  timeoutMs: number;
  maxBytes: number;
}) => Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  bodyBuffer: Buffer;
}>;

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    value = (value << 8) | num;
  }
  return value >>> 0;
}

function isPrivateOrReservedIpv4Int(n: number): boolean {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;

  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // Link-local / cloud metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // Private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // Private 192.168.0.0/16
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // Multicast & reserved 224.0.0.0/4+
  return false;
}

export function parseIpv6Groups(rawIp: string): number[] | null {
  const clean = rawIp.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!net.isIPv6(clean)) return null;

  const halves = clean.split('::');
  if (halves.length > 2) return null;

  const expandHalf = (half: string): number[] | null => {
    if (!half) return [];
    const tokens = half.split(':');
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.includes('.')) {
        // Embedded trailing IPv4
        if (i !== tokens.length - 1) return null;
        const v4 = parseIpv4ToInt(token);
        if (v4 === null) return null;
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
        groups.push(parseInt(token, 16));
      }
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = expandHalf(halves[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = expandHalf(halves[0]);
  const right = expandHalf(halves[1]);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();

  if (net.isIPv4(clean)) {
    const v4 = parseIpv4ToInt(clean);
    return v4 === null ? true : isPrivateOrReservedIpv4Int(v4);
  }

  if (net.isIPv6(clean)) {
    const g = parseIpv6Groups(clean);
    if (!g) return true;

    const allZeroPrefix =
      g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;

    // Unspecified :: and Loopback ::1
    if (allZeroPrefix && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
      return true;
    }

    // IPv4-mapped IPv6 ::ffff:0:0/96 and IPv4-compatible ::/96
    if (allZeroPrefix && (g[5] === 0xffff || g[5] === 0)) {
      const embeddedV4 = ((g[6] << 16) | g[7]) >>> 0;
      return isPrivateOrReservedIpv4Int(embeddedV4);
    }

    // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      const embeddedV4 = ((g[6] << 16) | g[7]) >>> 0;
      return isPrivateOrReservedIpv4Int(embeddedV4);
    }
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) {
      return true;
    }

    // Unique Local Addresses fc00::/7 (fc00..fdff)
    if ((g[0] & 0xfe00) === 0xfc00) return true;

    // Link-Local fe80::/10 (fe80..febf)
    if ((g[0] & 0xffc0) === 0xfe80) return true;

    // Multicast ff00::/8
    if ((g[0] & 0xff00) === 0xff00) return true;

    // Discard-Only 100::/64
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;

    // Documentation 2001:db8::/32
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;

    // Teredo 2001::/32
    if (g[0] === 0x2001 && g[1] === 0x0000) return true;

    return false;
  }

  return true;
}

const defaultDnsLookup: DnsLookupFn = async (hostname: string) => {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }));
};

export async function resolveAndValidatePublicIps(
  hostname: string,
  lookupFn: DnsLookupFn = defaultDnsLookup
): Promise<{
  valid: boolean;
  addresses: ResolvedAddress[];
  error?: string;
}> {
  if (isRestrictedHostname(hostname)) {
    return {
      valid: false,
      addresses: [],
      error: `Hostname "${hostname}" is restricted.`,
    };
  }

  try {
    const records = await lookupFn(hostname);
    if (!records || records.length === 0) {
      return {
        valid: false,
        addresses: [],
        error: `DNS lookup returned no addresses for "${hostname}".`,
      };
    }

    // Reject the entire DNS response if ANY record resolves to a private/reserved IP
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        return {
          valid: false,
          addresses: [],
          error:
            'DNS validation rejected private, loopback, link-local, or mixed public/private records.',
        };
      }
    }

    return { valid: true, addresses: records };
  } catch {
    return {
      valid: false,
      addresses: [],
      error: `DNS resolution failed for "${hostname}".`,
    };
  }
}

export function validateRedirectDestination(
  locationHeader: string,
  allowedHostnames: ReadonlySet<string>,
  baseUrl?: string
): { safe: boolean; resolvedUrl?: string; reason?: string } {
  let candidate = locationHeader.trim();
  if (!candidate) {
    return { safe: false, reason: 'Empty redirect Location header.' };
  }

  if (baseUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    try {
      candidate = new URL(candidate, baseUrl).toString();
    } catch {
      return { safe: false, reason: 'Malformed relative redirect destination.' };
    }
  }

  const check = validateExternalHttpsUrl(candidate);
  if (!check.valid || !check.parsed) {
    return {
      safe: false,
      reason: check.error || 'Redirect destination failed HTTPS security validation.',
    };
  }

  const destHost = check.parsed.hostname.toLowerCase();
  if (!allowedHostnames.has(destHost)) {
    return {
      safe: false,
      reason: `Redirect destination "${destHost}" is not in the provider allowlist.`,
    };
  }

  return { safe: true, resolvedUrl: check.normalizedUrl };
}

export function parseStrictContentLength(
  headerValue: string | string[] | undefined,
  maxBytes: number
): { valid: boolean; length: number | null; reason?: string } {
  if (headerValue === undefined) {
    return { valid: true, length: null };
  }

  const raw = Array.isArray(headerValue) ? headerValue : [headerValue];
  const normalizedValues = raw.map((v) => v.trim());

  if (normalizedValues.length === 0) {
    return { valid: true, length: null };
  }

  // Reject conflicting multiple Content-Length headers
  const unique = new Set(normalizedValues);
  if (unique.size > 1) {
    return {
      valid: false,
      length: null,
      reason: 'Conflicting Content-Length headers received.',
    };
  }

  const str = normalizedValues[0];
  if (!/^\d+$/.test(str)) {
    return {
      valid: false,
      length: null,
      reason: `Malformed Content-Length header "${str}".`,
    };
  }

  const num = Number(str);
  if (!Number.isSafeInteger(num) || num < 0) {
    return {
      valid: false,
      length: null,
      reason: 'Invalid Content-Length numeric range.',
    };
  }

  if (num > maxBytes) {
    return {
      valid: false,
      length: num,
      reason: `Response Content-Length (${num} bytes) exceeds ${maxBytes}-byte limit.`,
    };
  }

  return { valid: true, length: num };
}

export function isExactJsonContentType(
  headerValue: string | string[] | undefined
): boolean {
  const first = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!first) return false;
  const essence = first.split(';')[0].trim().toLowerCase();
  return essence === 'application/json';
}

const defaultPinnedTransport: TransportRequestFn = ({
  url,
  pinnedAddress,
  timeoutMs,
  maxBytes,
}) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const req = https.request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        servername: url.hostname,
        rejectUnauthorized: true,
        headers: {
          Host: url.hostname,
          Accept: 'application/json',
          'User-Agent': 'DOWNLYX-URL-Intelligence/2.1',
        },
        // Pin exact validated IP so no second DNS lookup can rebind
        lookup: (_hostname, opts, cb) => {
          if (typeof opts === 'object' && opts !== null && opts.all) {
            cb(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }]);
          } else {
            cb(null, pinnedAddress.address, pinnedAddress.family);
          }
        },
      },
      (res) => {
        const clCheck = parseStrictContentLength(
          res.headers['content-length'],
          maxBytes
        );
        if (!clCheck.valid) {
          settled = true;
          res.destroy();
          req.destroy();
          reject(new Error(clCheck.reason || 'Invalid Content-Length header.'));
          return;
        }

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            settled = true;
            res.destroy();
            req.destroy();
            reject(
              new Error(
                `Response body exceeded maximum ${maxBytes}-byte limit.`
              )
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            bodyBuffer: Buffer.concat(chunks),
          });
        });

        res.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy(new Error('Outbound metadata request timed out.'));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    req.end();
  });
};

export async function safePinnedProviderFetch<T extends Record<string, unknown>>(params: {
  providerId: MetadataProviderId;
  endpointUrl: string;
  lookupFn?: DnsLookupFn;
  transportFn?: TransportRequestFn;
}): Promise<{ ok: boolean; status: number; data?: T; warning?: string }> {
  const allowedHostnames = METADATA_ENDPOINT_ALLOWLIST[params.providerId];
  const check = validateExternalHttpsUrl(params.endpointUrl);
  if (!check.valid || !check.parsed) {
    return {
      ok: false,
      status: 0,
      warning: check.error || 'Metadata endpoint failed HTTPS security check.',
    };
  }

  const host = check.parsed.hostname.toLowerCase();
  if (!allowedHostnames.has(host)) {
    return {
      ok: false,
      status: 0,
      warning: `Endpoint host "${host}" is not on the ${params.providerId} metadata allowlist.`,
    };
  }

  const dnsResult = await resolveAndValidatePublicIps(host, params.lookupFn);
  if (!dnsResult.valid || dnsResult.addresses.length === 0) {
    return {
      ok: false,
      status: 0,
      warning: dnsResult.error || 'DNS verification rejected target host.',
    };
  }

  // Prefer IPv4 if available, otherwise first validated public IPv6
  const pinnedAddress =
    dnsResult.addresses.find((a) => a.family === 4) ?? dnsResult.addresses[0];

  const transport = params.transportFn ?? defaultPinnedTransport;

  try {
    const response = await transport({
      url: check.parsed,
      pinnedAddress,
      timeoutMs: HARD_TIMEOUT_MS,
      maxBytes: HARD_MAX_RESPONSE_BYTES,
    });

    // Never silently follow redirects; independently inspect Location for audit clarity
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const rawLoc = response.headers['location'];
      const locStr = Array.isArray(rawLoc) ? rawLoc[0] || '' : rawLoc || '';
      const redirectCheck = validateRedirectDestination(
        locStr,
        allowedHostnames,
        check.normalizedUrl
      );
      return {
        ok: false,
        status: response.statusCode,
        warning: redirectCheck.safe
          ? 'Redirects are refused on authorized metadata lookups.'
          : redirectCheck.reason || 'Blocked unsafe redirect from metadata endpoint.',
      };
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        ok: false,
        status: response.statusCode,
        warning: `Provider metadata endpoint returned HTTP ${response.statusCode}.`,
      };
    }

    if (!isExactJsonContentType(response.headers['content-type'])) {
      return {
        ok: false,
        status: response.statusCode,
        warning: 'Provider metadata response did not have exact application/json Content-Type.',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyBuffer.toString('utf8'));
    } catch {
      return {
        ok: false,
        status: response.statusCode,
        warning: 'Provider metadata response contained invalid JSON.',
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        status: response.statusCode,
        warning: 'Provider metadata response was not a valid JSON object.',
      };
    }

    return {
      ok: true,
      status: response.statusCode,
      data: parsed as T,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      warning:
        err instanceof Error
          ? err.message
          : 'Authorized metadata endpoint failed security or network checks.',
    };
  }
}

export function resolveClientIp(
  req: Request,
  options?: { trustProxy?: boolean }
): string {
  const socketIp = req.socket?.remoteAddress || 'unknown';
  const trustProxy =
    options?.trustProxy ?? process.env.TRUST_PROXY === 'true';

  if (!trustProxy) {
    return socketIp;
  }

  // Only trust X-Forwarded-For when direct TCP peer is a loopback/private proxy
  const normalizedPeer = socketIp.replace(/^::ffff:/, '');
  if (!isPrivateOrReservedIp(normalizedPeer)) {
    return socketIp;
  }

  const xff = req.headers['x-forwarded-for'];
  const rawXff = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (!rawXff) {
    return socketIp;
  }

  // Select rightmost non-private IP hop added by the trusted proxy (ignores spoofed leftmost entries)
  const hops = rawXff
    .split(',')
    .map((h) => h.trim())
    .filter((h) => net.isIP(h) !== 0);

  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isPrivateOrReservedIp(hops[i])) {
      return hops[i];
    }
  }

  return hops[hops.length - 1] || socketIp;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const MAX_RATE_LIMIT_BUCKETS = 10_000;

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  trustProxy?: boolean;
  maxBuckets?: number;
}) {
  const buckets = new Map<string, RateBucket>();
  const maxBuckets = Math.min(
    MAX_RATE_LIMIT_BUCKETS,
    Math.max(1, Math.floor(options.maxBuckets ?? MAX_RATE_LIMIT_BUCKETS))
  );

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const clientIp = resolveClientIp(req, { trustProxy: options.trustProxy });
    const existing = buckets.get(clientIp);

    if (!existing || now >= existing.resetAt) {
      if (buckets.size >= maxBuckets) {
        // Expired buckets may be reclaimed, but never evict a live client's
        // bucket: doing so lets an attacker rotate spoofed IPs to reset limits.
        for (const [key, bucket] of buckets) {
          if (now >= bucket.resetAt) buckets.delete(key);
        }
      }
      if (buckets.size >= maxBuckets) {
        res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(options.windowMs / 1000))));
        res.status(429).json({
          success: false,
          validationStatus: 'blocked',
          error: 'Rate limiter capacity reached. Retry after the current rate-limit window.',
        });
        return;
      }
      const fresh: RateBucket = {
        count: 1,
        resetAt: now + options.windowMs,
      };
      buckets.set(clientIp, fresh);
      res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(options.maxRequests - 1));
      next();
      return;
    }

    if (existing.count >= options.maxRequests) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1000)
      );
      res.setHeader('Retry-After', String(retryAfterSec));
      res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.status(429).json({
        success: false,
        platform: 'unsupported',
        platformName: 'Rate Limited',
        normalizedUrl: '',
        hostname: '',
        mediaType: 'Unknown',
        resourceId: null,
        validationStatus: 'blocked',
        capabilities: {
          urlDetection: 'unknown',
          metadataAvailability: 'unknown',
          authorizedMediaRetrieval: 'unknown',
          actualDownloadAvailability: 'not_available',
        },
        availableFormats: [],
        qualityOptions: [],
        metadataStatus: 'unavailable',
        warnings: ['API rate limit reached. Wait briefly before retrying.'],
        error: `Too many requests. Try again in ${retryAfterSec} seconds.`,
        analyzedAt: new Date().toISOString(),
      });
      return;
    }

    existing.count += 1;
    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader(
      'X-RateLimit-Remaining',
      String(Math.max(0, options.maxRequests - existing.count))
    );
    next();
  };
}
