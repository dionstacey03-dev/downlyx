import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import type { HistoryItem, UserPreferences } from '../../src/types/media.ts';
import { normalizeQualityPreference } from '../../src/utils/platformDetector.ts';
import {
  ALL_ELIGIBLE_DIRECT_FORMATS,
  checkProviderDownloadAuthorization,
  normalizeDirectFormat,
} from '../integrations/providerIntegrations.ts';
import {
  createFirebaseAuthMiddleware,
  deleteFirebaseUserAccount,
  requireVerifiedEmail,
  revokeFirebaseUserRefreshTokens,
  type FirebaseAuthRequest,
  type TokenVerifierFn,
} from '../security/firebaseAdmin.ts';
import { createRateLimiter } from '../security/urlSecurity.ts';
import { analyzeUrlIntelligence } from '../services/urlIntelligenceService.ts';
import { MediaWorkerManager } from '../worker/mediaWorkerManager.ts';
import {
  deleteUserData,
  getUserHistory,
  getUserPreferences,
  setUserPreferences,
  updateUserHistory,
} from '../storage/userDataStore.ts';

export interface MediaRouterOptions {
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  downloadRateLimitMax?: number;
  skipNetworkMetadata?: boolean;
  workerManager?: MediaWorkerManager;
  tempDir?: string;
  tokenVerifier?: TokenVerifierFn;
  requireEmailVerification?: boolean;
}

export function createMediaRouter(options?: MediaRouterOptions) {
  const router = express.Router();

  // Express 4 does not forward rejected promises from async route handlers.
  // Wrap route middleware centrally so unexpected async failures reach the
  // API error handler instead of becoming unhandled rejections/hung requests.
  const asyncHandler = (handler: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => {
      try {
        const result = (handler as (
          req: express.Request,
          res: express.Response,
          next: express.NextFunction
        ) => unknown)(req, res, next);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          void Promise.resolve(result).catch(next);
        }
      } catch (error) {
        next(error);
      }
    };

  const routeMethods = ['get', 'post', 'put', 'patch', 'delete'] as const;
  for (const method of routeMethods) {
    const original = router[method].bind(router) as (...args: unknown[]) => express.Router;
    (router as unknown as Record<string, (...args: unknown[]) => express.Router>)[method] =
      (...args: unknown[]) => {
        const wrapped = args.map((arg, index) =>
          index > 0 && typeof arg === 'function'
            ? asyncHandler(arg as express.RequestHandler)
            : arg
        );
        return original(...wrapped);
      };
  }

  const workerManager =
    options?.workerManager ??
    new MediaWorkerManager({
      tempDir: options?.tempDir,
    });

  const analyzeLimiter = createRateLimiter({
    windowMs: options?.rateLimitWindowMs ?? 60_000,
    maxRequests: options?.rateLimitMax ?? 60,
  });

  const downloadLimiter = createRateLimiter({
    windowMs: options?.rateLimitWindowMs ?? 60_000,
    maxRequests: options?.downloadRateLimitMax ?? 25,
  });

  const requireFirebaseAuth = createFirebaseAuthMiddleware(options?.tokenVerifier);
  const enforceVerifiedEmail =
    options?.requireEmailVerification === false
      ? (
          _req: FirebaseAuthRequest,
          _res: express.Response,
          next: express.NextFunction
        ) => next()
      : requireVerifiedEmail;

  // Enforce strict security headers across all API responses
  router.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      phase: 4,
      service: 'downlyx-media-engine',
      authProvider: 'firebase',
      workerIsolation: workerManager.getWorkerIsolationSummary(),
    });
  });

  // Legacy anonymous session endpoint disabled after Phase 4 Firebase migration
  router.post('/session', (_req, res) => {
    res.status(410).json({
      error:
        'Anonymous workspace sessions have been replaced by Firebase Authentication. Sign in to obtain a verified ID token.',
      code: 'auth/session-migrated',
    });
  });

  router.get('/auth/me', requireFirebaseAuth, (req: FirebaseAuthRequest, res) => {
    res.status(200).json({ user: req.authUser });
  });

  router.post(
    '/auth/logout',
    requireFirebaseAuth,
    async (req: FirebaseAuthRequest, res) => {
      const uid = req.authUser!.uid;
      const bearer = req.headers.authorization?.slice('Bearer '.length).trim();
      try {
        await revokeFirebaseUserRefreshTokens(uid, { exactToken: bearer });
        res.status(200).json({ loggedOut: true });
      } catch {
        // Express 4 does not automatically forward rejected async route handlers.
        res.status(503).json({
          loggedOut: false,
          error: 'Session revocation could not be confirmed. Please retry.',
          code: 'auth/revocation-unavailable',
        });
      }
    }
  );

  router.delete(
    '/account',
    requireFirebaseAuth,
    async (req: FirebaseAuthRequest, res) => {
      const uid = req.authUser!.uid;
      const bearer = req.headers.authorization?.slice('Bearer '.length).trim();
      let purgedJobsCount = 0;
      try {
        // Remove application data before deleting the Firebase identity so a
        // transient Auth Admin failure remains retryable by the signed-in user.
        purgedJobsCount = await workerManager.purgeJobsForOwner(uid);
        await deleteUserData(uid);
        await deleteFirebaseUserAccount(uid, { exactToken: bearer });
        res.status(200).json({ deleted: true, purgedJobsCount });
      } catch {
        res.status(503).json({
          deleted: false,
          purgedJobsCount,
          error: 'Account deletion could not be confirmed. Please retry.',
          code: 'auth/account-deletion-unavailable',
        });
      }
    }
  );

  router.post(
    '/analyze',
    express.json({ limit: '16kb' }),
    analyzeLimiter,
    async (req, res) => {
      if (!req.body || typeof req.body.url !== 'string') {
        const result = await analyzeUrlIntelligence('', {
          skipNetworkMetadata: options?.skipNetworkMetadata,
        });
        res.status(400).json(result.payload);
        return;
      }

      const result = await analyzeUrlIntelligence(req.body.url, {
        skipNetworkMetadata: options?.skipNetworkMetadata,
      });
      res.status(result.httpStatus).json(result.payload);
    }
  );

  router.post(
    '/downloads',
    express.json({ limit: '16kb' }),
    downloadLimiter,
    requireFirebaseAuth,
    enforceVerifiedEmail,
    async (req: FirebaseAuthRequest, res) => {
      // Never trust client-supplied ownerId; strictly derive from verified Firebase UID
      const ownerId = req.authUser!.uid;
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
      const userConfirmedPermission = req.body?.userConfirmedPermission === true;

      if (!rawUrl.trim()) {
        res.status(400).json({ error: 'A valid HTTPS media URL is required.' });
        return;
      }

      const analysis = await analyzeUrlIntelligence(rawUrl, {
        skipNetworkMetadata: true,
      });

      if (
        analysis.payload.validationStatus === 'invalid' ||
        analysis.payload.validationStatus === 'blocked'
      ) {
        res
          .status(400)
          .json({ error: analysis.payload.error || 'Invalid or blocked media URL.' });
        return;
      }

      if (!analysis.payload.success) {
        res.status(403).json({
          error:
            analysis.payload.error ||
            'This URL is unsupported or restricted from download.',
        });
        return;
      }

      const authz = checkProviderDownloadAuthorization({
        platform: analysis.payload.platform,
        mediaType: analysis.payload.mediaType,
        userConfirmedPermission,
      });
      if (!authz.authorized) {
        res.status(403).json({ error: authz.reason });
        return;
      }

      const expectedExt = normalizeDirectFormat(
        analysis.payload.directMediaVerification?.expectedContainer
      );
      const requestedFormat = normalizeDirectFormat(
        typeof req.body?.targetFormat === 'string' && req.body.targetFormat.trim()
          ? req.body.targetFormat
          : expectedExt
      );

      const permittedFormats = analysis.payload.permittedOutputFormats ?? [];
      if (
        !ALL_ELIGIBLE_DIRECT_FORMATS.has(requestedFormat) ||
        (permittedFormats.length > 0 && !permittedFormats.includes(requestedFormat))
      ) {
        res.status(400).json({
          error: `Unsupported or disallowed target format "${requestedFormat || 'unknown'}".`,
        });
        return;
      }

      const savedPrefs = await getUserPreferences(ownerId);
      const autoRetry =
        typeof req.body?.autoRetry === 'boolean'
          ? req.body.autoRetry
          : Boolean(savedPrefs?.autoRetry);

      const started = await workerManager.startDownloadJob({
        ownerId,
        url: analysis.payload.normalizedUrl,
        platform: analysis.payload.platform,
        platformName: analysis.payload.platformName,
        mediaType: analysis.payload.mediaType,
        targetFormat: requestedFormat,
        autoRetry,
      });

      if (!started.ok) {
        res.status(started.status).json({ error: started.error });
        return;
      }

      res.status(202).json({ job: started.job });
    }
  );

  router.get(
    '/downloads',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    (req: FirebaseAuthRequest, res) => {
      const jobs = workerManager.listJobsForOwner(req.authUser!.uid);
      res.status(200).json({ jobs });
    }
  );

  router.get(
    '/downloads/:id',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    (req: FirebaseAuthRequest, res) => {
      const jobId = String(req.params.id || '');
      const result = workerManager.getJobForOwner(jobId, req.authUser!.uid);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.status(200).json({ job: result.job });
    }
  );

  router.post(
    '/downloads/:id/token',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    (req: FirebaseAuthRequest, res) => {
      const jobId = String(req.params.id || '');
      const issued = workerManager.issueFreshDownloadToken(
        jobId,
        req.authUser!.uid
      );
      if (!issued.ok) {
        res.status(issued.status).json({ error: issued.error });
        return;
      }
      res.status(200).json({
        downloadToken: issued.downloadToken,
        expiresAt: issued.expiresAt,
      });
    }
  );

  router.delete(
    '/downloads/:id',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    async (req: FirebaseAuthRequest, res) => {
      const jobId = String(req.params.id || '');
      const result = await workerManager.cancelOrDeleteJob(
        jobId,
        req.authUser!.uid
      );
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.status(200).json({ job: result.job });
    }
  );

  router.get(
    '/downloads/:id/file',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    (req: FirebaseAuthRequest, res) => {
      if (req.query.token !== undefined) {
        res.status(400).json({
          error:
            'Download tokens must not be passed in URL query parameters. Use X-Download-Token header.',
        });
        return;
      }

      const jobId = String(req.params.id || '');
      const headerToken = req.header('x-download-token') || '';
      if (!headerToken) {
        res.status(401).json({ error: 'X-Download-Token header is required.' });
        return;
      }

      const resolved = workerManager.resolveDownloadableFile({
        jobId,
        token: headerToken,
        requesterOwnerId: req.authUser!.uid,
      });
      if (!resolved.ok) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      res.setHeader('Content-Type', resolved.mimeType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${resolved.filename}"`
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, private'
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Referrer-Policy', 'no-referrer');

      const stream = fs.createReadStream(resolved.filePath);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream download file.' });
        } else {
          res.destroy();
        }
      });
      res.on('close', () => {
        stream.destroy();
      });
      stream.pipe(res);
    }
  );

  router.get(
    '/history',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    async (req: FirebaseAuthRequest, res) => {
      const uid = req.authUser!.uid;
      res.json({ items: await getUserHistory(uid) });
    }
  );

  router.post(
    '/history',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    async (req: FirebaseAuthRequest, res) => {
      const uid = req.authUser!.uid;
      const userPrefs = await getUserPreferences(uid);
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
      const qualityPreference =
        typeof req.body?.qualityPreference === 'string' &&
        req.body.qualityPreference.trim()
          ? req.body.qualityPreference.trim().slice(0, 40)
          : userPrefs.defaultQuality;
      const requestedFormat =
        typeof req.body?.fileType === 'string'
          ? req.body.fileType.slice(0, 24)
          : '';

      const analysis = await analyzeUrlIntelligence(rawUrl, {
        skipNetworkMetadata: true,
      });

      if (
        analysis.payload.validationStatus === 'invalid' ||
        analysis.payload.validationStatus === 'blocked'
      ) {
        res.status(400).json({ error: analysis.payload.error || 'Invalid URL' });
        return;
      }

      const item: HistoryItem = {
        id: crypto.randomUUID(),
        url: analysis.payload.normalizedUrl,
        platform: analysis.payload.platform,
        platformName: analysis.payload.platformName,
        mediaType: analysis.payload.mediaType,
        fileType:
          requestedFormat && requestedFormat !== 'Unverified'
            ? requestedFormat
            : analysis.payload.availableFormats[0] ||
              (analysis.payload.directMediaVerification?.expectedContainer
                ? `Probable ${analysis.payload.directMediaVerification.expectedContainer}`
                : 'Unverified'),
        qualityPreference,
        status: analysis.payload.success ? 'analyzed' : 'unsupported',
        resourceId: analysis.payload.resourceId,
        createdAt: new Date().toISOString(),
        note: analysis.payload.success
          ? 'Validated by URL Intelligence Engine'
          : analysis.payload.error || 'Unsupported or restricted source logged',
      };

      await updateUserHistory(uid, (prev) => ({
        history: [item, ...prev].slice(0, 100),
        result: undefined,
      }));
      res.status(201).json({ item });
    }
  );

  router.delete(
    '/history/:id',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    async (req: FirebaseAuthRequest, res) => {
      const uid = req.authUser!.uid;
      const id = req.params.id;
      const deleted = await updateUserHistory(uid, (prev) => {
        const next = prev.filter((item) => item.id !== id);
        return { history: next, result: next.length !== prev.length };
      });
      if (!deleted) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }
      res.json({ deleted: true });
    }
  );

  router.delete(
    '/history',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    async (req: FirebaseAuthRequest, res) => {
      await updateUserHistory(req.authUser!.uid, () => ({
        history: [],
        result: undefined,
      }));
      res.json({ cleared: true });
    }
  );

  router.post(
    '/history/batch-delete',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    async (req: FirebaseAuthRequest, res) => {
      const uid = req.authUser!.uid;
      const rawIds: unknown = req.body?.ids;
      if (!Array.isArray(rawIds)) {
        res.status(400).json({ error: 'ids array is required.' });
        return;
      }

      const requestedIds = Array.from(
        new Set(
          rawIds
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter(Boolean)
        )
      ).slice(0, 100);

      if (requestedIds.length === 0) {
        res.status(400).json({ error: 'At least one history item id is required.' });
        return;
      }

      const idSet = new Set(requestedIds);
      const removedItems = await updateUserHistory(uid, (prev) => {
        const removed = prev.filter((item) => idSet.has(item.id));
        const remaining = prev.filter((item) => !idSet.has(item.id));
        return { history: remaining, result: removed };
      });

      const jobIdsToCancel = Array.from(
        new Set(
          removedItems
            .map((item) => item.jobId)
            .filter((jobId): jobId is string => Boolean(jobId))
        )
      );
      if (jobIdsToCancel.length > 0) {
        await Promise.allSettled(
          jobIdsToCancel.map((jobId) =>
            workerManager.cancelOrDeleteJob(jobId, uid)
          )
        );
      }

      res.json({
        deletedIds: removedItems.map((item) => item.id),
        deletedCount: removedItems.length,
      });
    }
  );

  router.get(
    '/preferences',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    async (req: FirebaseAuthRequest, res) => {
      const uid = req.authUser!.uid;
      res.json({ preferences: await getUserPreferences(uid) });
    }
  );

  router.put(
    '/preferences',
    requireFirebaseAuth,
    enforceVerifiedEmail,
    async (req: FirebaseAuthRequest, res) => {
      const uid = req.authUser!.uid;
      const current = await getUserPreferences(uid);
      const body = req.body ?? {};
      const allowedFormats = new Set(['mp4', 'webm', 'mp3', 'm4a']);

      const updated: UserPreferences = {
        defaultQuality:
          typeof body.defaultQuality === 'string'
            ? normalizeQualityPreference(body.defaultQuality)
            : current.defaultQuality,
        defaultFormat: allowedFormats.has(body.defaultFormat)
          ? body.defaultFormat
          : current.defaultFormat,
        autoDetectClipboard:
          typeof body.autoDetectClipboard === 'boolean'
            ? body.autoDetectClipboard
            : current.autoDetectClipboard,
        saveHistoryLocally:
          typeof body.saveHistoryLocally === 'boolean'
            ? body.saveHistoryLocally
            : current.saveHistoryLocally,
        autoRetry:
          typeof body.autoRetry === 'boolean'
            ? body.autoRetry
            : current.autoRetry,
        workspaceName:
          typeof body.workspaceName === 'string' && body.workspaceName.trim()
            ? body.workspaceName.trim().slice(0, 60)
            : current.workspaceName,
      };

      await setUserPreferences(uid, updated);
      res.json({ preferences: updated });
    }
  );

  return router;
}

export const mediaRouter = createMediaRouter();
