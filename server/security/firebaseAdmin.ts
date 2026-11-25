import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import { getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';

export interface VerifiedFirebaseUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  authTimeSeconds: number;
  issuedAtSeconds: number;
}

export type TokenVerifierFn = (
  idToken: string,
  options?: { checkRevoked?: boolean }
) => Promise<VerifiedFirebaseUser>;

export class FirebaseTokenVerificationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 401, code = 'auth/invalid-token') {
    super(message);
    this.name = 'FirebaseTokenVerificationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface FirebaseAuthRequest extends Request {
  authUser?: VerifiedFirebaseUser;
  workspaceOwnerId?: string;
}

// Per-process revocation store for immediate logout/account-deletion enforcement
const revokedBeforeSecByUid = new Map<string, number>();
const revokedTokenHashes = new Map<string, number>();
const deletedUids = new Set<string>();
const MAX_REVOCATION_ENTRIES = 10_000;

function hashTokenForRevocation(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function markUserSessionRevoked(
  uid: string,
  timestampMs = Date.now(),
  options?: { exactToken?: string; accountDeleted?: boolean }
): void {
  if (!uid) return;
  if (options?.accountDeleted) {
    deletedUids.add(uid);
  }
  const timestampSec = Math.floor(timestampMs / 1000);
  revokedBeforeSecByUid.set(uid, timestampSec);
  while (revokedBeforeSecByUid.size > MAX_REVOCATION_ENTRIES) {
    const oldest = revokedBeforeSecByUid.keys().next().value;
    if (oldest === undefined) break;
    revokedBeforeSecByUid.delete(oldest);
  }
  if (options?.exactToken) {
    revokedTokenHashes.set(
      hashTokenForRevocation(options.exactToken.trim()),
      Date.now()
    );
    while (revokedTokenHashes.size > MAX_REVOCATION_ENTRIES) {
      const oldest = revokedTokenHashes.keys().next().value;
      if (oldest === undefined) break;
      revokedTokenHashes.delete(oldest);
    }
  }
}

export function clearLocalRevocationWatermarksForTest(): void {
  revokedBeforeSecByUid.clear();
  revokedTokenHashes.clear();
  deletedUids.clear();
}

function resolveFirebaseProjectId(): string {
  if (process.env.FIREBASE_PROJECT_ID?.trim()) {
    return process.env.FIREBASE_PROJECT_ID.trim();
  }
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        projectId?: string;
      };
      if (parsed.projectId && parsed.projectId !== 'remixed-project-id') {
        return parsed.projectId;
      }
    } catch {
      // Fallback handled below
    }
  }
  throw new Error(
    'Firebase projectId is not configured. Run Firebase setup or set FIREBASE_PROJECT_ID.'
  );
}

export function getFirebaseAdminApp(): App {
  if (getApps().length > 0) {
    return getApp();
  }
  const projectId = resolveFirebaseProjectId();
  return initializeApp({ projectId });
}

function mapDecodedToken(decoded: DecodedIdToken): VerifiedFirebaseUser {
  return {
    uid: decoded.uid,
    email: typeof decoded.email === 'string' ? decoded.email : null,
    emailVerified: decoded.email_verified === true,
    name: typeof decoded.name === 'string' ? decoded.name : null,
    picture: typeof decoded.picture === 'string' ? decoded.picture : null,
    authTimeSeconds:
      typeof decoded.auth_time === 'number' ? decoded.auth_time : 0,
    issuedAtSeconds: typeof decoded.iat === 'number' ? decoded.iat : 0,
  };
}

function isIamUnavailableError(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
  const msg = err instanceof Error ? err.message : String(err);
  const combined = `${code} ${msg}`.toLowerCase();
  return (
    combined.includes('insufficient-permission') ||
    combined.includes('permission_denied') ||
    combined.includes('could not load the default credentials') ||
    combined.includes('unable to detect a project id') ||
    combined.includes('metadata server')
  );
}

export async function verifyFirebaseIdToken(
  idToken: string,
  options?: { checkRevoked?: boolean }
): Promise<VerifiedFirebaseUser> {
  const trimmed = idToken.trim();
  if (!trimmed || trimmed.length > 8192) {
    throw new FirebaseTokenVerificationError(
      'Malformed Firebase ID token.',
      401,
      'auth/invalid-id-token'
    );
  }

  if (revokedTokenHashes.has(hashTokenForRevocation(trimmed))) {
    throw new FirebaseTokenVerificationError(
      'Session token has been revoked. Please sign in again.',
      401,
      'auth/id-token-revoked'
    );
  }

  const app = getFirebaseAdminApp();
  const auth = getAuth(app);
  const shouldCheckRevoked =
    options?.checkRevoked ?? process.env.FIREBASE_CHECK_REVOKED !== 'false';

  let decoded: DecodedIdToken;
  try {
    decoded = await auth.verifyIdToken(trimmed, shouldCheckRevoked);
  } catch (err) {
    if (
      shouldCheckRevoked &&
      process.env.FIREBASE_STRICT_ADMIN_REVOCATION !== 'true' &&
      isIamUnavailableError(err)
    ) {
      // Fallback to cryptographic signature + expiry verification when IAM accounts:lookup is unavailable (e.g., Starter Tier preview)
      try {
        decoded = await auth.verifyIdToken(trimmed, false);
      } catch (innerErr) {
        throw classifyVerifyError(innerErr);
      }
    } else {
      throw classifyVerifyError(err);
    }
  }

  const user = mapDecodedToken(decoded);
  if (deletedUids.has(user.uid)) {
    throw new FirebaseTokenVerificationError(
      'This account has been deleted.',
      401,
      'auth/user-not-found'
    );
  }

  const revokedBeforeSec = revokedBeforeSecByUid.get(user.uid);
  if (revokedBeforeSec !== undefined) {
    const tokenTimestampSec = Math.max(user.issuedAtSeconds, user.authTimeSeconds);
    if (tokenTimestampSec < revokedBeforeSec) {
      throw new FirebaseTokenVerificationError(
        'Session token has been revoked. Please sign in again.',
        401,
        'auth/id-token-revoked'
      );
    }
  }

  return user;
}

function classifyVerifyError(err: unknown): FirebaseTokenVerificationError {
  if (err instanceof FirebaseTokenVerificationError) return err;
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : 'auth/invalid-id-token';

  if (code === 'auth/id-token-expired') {
    return new FirebaseTokenVerificationError(
      'Firebase ID token has expired. Please refresh your session or sign in again.',
      401,
      code
    );
  }
  if (code === 'auth/id-token-revoked') {
    return new FirebaseTokenVerificationError(
      'Firebase ID token has been revoked. Please sign in again.',
      401,
      code
    );
  }
  if (code === 'auth/user-disabled') {
    return new FirebaseTokenVerificationError(
      'This user account has been disabled.',
      403,
      code
    );
  }
  return new FirebaseTokenVerificationError(
    'Invalid Firebase ID token.',
    401,
    code
  );
}

export async function revokeFirebaseUserRefreshTokens(
  uid: string,
  options?: { exactToken?: string; accountDeleted?: boolean }
): Promise<void> {
  markUserSessionRevoked(uid, Date.now(), options);
  try {
    const app = getFirebaseAdminApp();
    await getAuth(app).revokeRefreshTokens(uid);
  } catch (err) {
    if (!isIamUnavailableError(err)) {
      // Log non-IAM errors subtly without leaking credentials
      console.warn('Unable to call Firebase Admin revokeRefreshTokens:', err instanceof Error ? err.message : 'unknown');
    }
  }
}

export function createFirebaseAuthMiddleware(customVerifier?: TokenVerifierFn) {
  const verify = customVerifier ?? verifyFirebaseIdToken;

  return async function requireFirebaseAuth(
    req: FirebaseAuthRequest,
    res: Response,
    next: NextFunction
  ) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Authentication required. Missing Firebase Bearer ID token.',
        code: 'auth/missing-token',
      });
      return;
    }

    const token = authHeader.slice('Bearer '.length).trim();
    try {
      const verified = await verify(token, {
        checkRevoked: process.env.FIREBASE_CHECK_REVOKED !== 'false',
      });
      req.authUser = verified;
      req.workspaceOwnerId = verified.uid;
      next();
    } catch (err) {
      if (err instanceof FirebaseTokenVerificationError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(401).json({
        error: 'Invalid or expired authentication token.',
        code: 'auth/invalid-token',
      });
    }
  };
}

export function requireVerifiedEmail(
  req: FirebaseAuthRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (!req.authUser.emailVerified) {
    res.status(403).json({
      error:
        'Email verification is required before creating downloads or syncing history.',
      code: 'auth/email-unverified',
    });
    return;
  }
  next();
}
