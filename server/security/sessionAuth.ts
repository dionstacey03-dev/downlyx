import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const EPHEMERAL_SECRET = crypto.randomBytes(32).toString('hex');

/**
 * Fail closed in production if a stable signing key is not configured.
 * A process-random key invalidates signed links on restart and, more
 * importantly, makes tokens issued by one replica unverifiable by another.
 */
export function assertSessionSecretConfigured(): void {
  const configured = process.env.DOWNLYX_SESSION_SECRET?.trim();
  if (process.env.NODE_ENV === 'production' && (!configured || Buffer.byteLength(configured, 'utf8') < 32)) {
    throw new Error('DOWNLYX_SESSION_SECRET must be configured with at least 32 bytes in production.');
  }
}

// Single-use nonce registry prevents replay of consumed download tokens
const consumedDownloadNonces = new Map<string, number>();
const MAX_NONCE_CACHE = 10_000;

function getSigningSecret(): string {
  assertSessionSecretConfigured();
  return process.env.DOWNLYX_SESSION_SECRET?.trim() || EPHEMERAL_SECRET;
}

function signPayload(payloadB64: string): string {
  return crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');
}

function timingSafeMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function pruneExpiredNonces(now = Date.now()) {
  for (const [jti, exp] of consumedDownloadNonces.entries()) {
    if (now > exp) {
      consumedDownloadNonces.delete(jti);
    }
  }
  // Do not evict unexpired consumed IDs: eviction would re-enable replay.
}

export interface WorkspaceSessionPayload {
  ownerId: string;
  issuedAt: number;
  expiresAt: number;
}

export function issueWorkspaceSessionToken(
  ownerId = crypto.randomUUID(),
  ttlMs = 24 * 60 * 60 * 1000
): { token: string; ownerId: string; expiresAt: string } {
  if (typeof ownerId !== 'string' || ownerId.trim().length < 1 || ownerId.length > 128) {
    throw new Error('Workspace session ownerId must be a non-empty string of at most 128 characters.');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) {
    throw new Error('Workspace session TTL must be between 1ms and 24 hours.');
  }
  const now = Date.now();
  const payload: WorkspaceSessionPayload = {
    ownerId,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signPayload(payloadB64);
  return {
    token: `${payloadB64}.${signature}`,
    ownerId,
    expiresAt: new Date(payload.expiresAt).toISOString(),
  };
}

export function verifyWorkspaceSessionToken(
  token: string
): WorkspaceSessionPayload | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = signPayload(payloadB64);
  if (!timingSafeMatch(sig, expectedSig)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as WorkspaceSessionPayload;
    if (
      !parsed ||
      typeof parsed.ownerId !== 'string' ||
      parsed.ownerId.length < 1 ||
      parsed.ownerId.length > 128 ||
      typeof parsed.issuedAt !== 'number' ||
      !Number.isFinite(parsed.issuedAt) ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= parsed.issuedAt ||
      parsed.expiresAt - parsed.issuedAt > 24 * 60 * 60 * 1000 ||
      parsed.issuedAt > Date.now() + 60_000
    ) {
      return null;
    }
    if (Date.now() > parsed.expiresAt) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export interface DownloadAccessPayload {
  jti: string;
  jobId: string;
  ownerId: string;
  fileId: string;
  expiresAt: number;
}

export function createSignedDownloadToken(params: {
  jobId: string;
  ownerId: string;
  fileId: string;
  ttlMs?: number;
}): { token: string; expiresAt: string } {
  const ttlMs = params.ttlMs ?? 5 * 60 * 1000;
  if (!params.jobId || params.jobId.length > 128 || !params.ownerId || params.ownerId.length > 128 || !params.fileId || params.fileId.length > 256) {
    throw new Error('Download token identifiers are missing or exceed their allowed length.');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) {
    throw new Error('Download token TTL must be between 1ms and 15 minutes.');
  }
  const expiresAt = Date.now() + ttlMs;
  const payload: DownloadAccessPayload = {
    jti: crypto.randomBytes(16).toString('hex'),
    jobId: params.jobId,
    ownerId: params.ownerId,
    fileId: params.fileId,
    expiresAt,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signPayload(`dl:${payloadB64}`);
  return {
    token: `${payloadB64}.${signature}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function verifySignedDownloadToken(
  token: string,
  expectedJobId: string,
  options?: { consume?: boolean }
): DownloadAccessPayload | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = signPayload(`dl:${payloadB64}`);
  if (!timingSafeMatch(sig, expectedSig)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as DownloadAccessPayload;
    if (
      !parsed ||
      typeof parsed.jti !== 'string' ||
      !/^[a-f0-9]{32}$/i.test(parsed.jti) ||
      parsed.jobId !== expectedJobId ||
      typeof parsed.ownerId !== 'string' ||
      parsed.ownerId.length < 1 ||
      parsed.ownerId.length > 128 ||
      typeof parsed.fileId !== 'string' ||
      parsed.fileId.length < 1 ||
      parsed.fileId.length > 256 ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      return null;
    }
    const now = Date.now();
    if (now > parsed.expiresAt || parsed.expiresAt - now > 15 * 60 * 1000) {
      return null;
    }

    pruneExpiredNonces(now);
    if (consumedDownloadNonces.has(parsed.jti)) {
      return null;
    }

    if (options?.consume !== false) {
      if (consumedDownloadNonces.size >= MAX_NONCE_CACHE) {
        // Fail closed rather than evict an unexpired nonce and permit replay.
        return null;
      }
      consumedDownloadNonces.set(parsed.jti, parsed.expiresAt);
    }

    return parsed;
  } catch {
    return null;
  }
}

export interface AuthenticatedRequest extends Request {
  workspaceOwnerId?: string;
}

export function requireWorkspaceSession(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Workspace authorization token is required.',
    });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const session = verifyWorkspaceSessionToken(token);
  if (!session) {
    res.status(401).json({
      error: 'Invalid or expired workspace session token.',
    });
    return;
  }

  req.workspaceOwnerId = session.ownerId;
  next();
}
