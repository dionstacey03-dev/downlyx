import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { mediaRouter } from './server/routes/media.ts';
import { assertSessionSecretConfigured } from './server/security/sessionAuth.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createServer() {
  // Validate security-critical configuration before opening the listener.
  assertSessionSecretConfigured();
  const app = express();
  const port = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

  // Explicit origin allowlist for a separately hosted Vite frontend.
  // Same-origin requests work without configuring CORS.
  const allowedOrigins = new Set(
    (process.env.DOWNLYX_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
  );

  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin) {
      let normalizedOrigin: string;
      try {
        normalizedOrigin = new URL(origin).origin;
      } catch {
        res.status(403).json({ error: 'Origin is not allowed.' });
        return;
      }

      let sameOrigin = false;
      try {
        sameOrigin =
          normalizedOrigin === new URL(`${req.protocol}://${req.get('host')}`).origin;
      } catch {
        sameOrigin = false;
      }

      if (!sameOrigin && !allowedOrigins.has(normalizedOrigin)) {
        res.status(403).json({ error: 'Origin is not allowed.' });
        return;
      }

      res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Download-Token');
      res.setHeader('Access-Control-Max-Age', '600');

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    } else if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  // Consistent JSON error response for oversized or malformed JSON bodies
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === 'entity.too.large') {
      res.status(413).json({
        success: false,
        validationStatus: 'blocked',
        error: 'Request payload exceeds the 16KB size limit.',
        warnings: ['Request size limit enforced.'],
      });
      return;
    }
    if (err instanceof SyntaxError && err.status === 400) {
      res.status(400).json({
        success: false,
        validationStatus: 'invalid',
        error: 'Malformed JSON request body.',
        warnings: [],
      });
      return;
    }
    next(err);
  });

  app.use('/api', mediaRouter);

  // Keep API failures in a consistent, sanitized JSON envelope. The original
  // exception is logged by type only; request secrets and upstream URLs are
  // never reflected to clients.
  app.use(
    '/api',
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      const candidate = err as { status?: unknown; statusCode?: unknown };
      const rawStatus = candidate?.statusCode ?? candidate?.status;
      const status =
        typeof rawStatus === 'number' &&
        Number.isInteger(rawStatus) &&
        rawStatus >= 400 &&
        rawStatus <= 599
          ? rawStatus
          : 500;
      console.error(
        'DOWNLYX API request failed:',
        err instanceof Error ? err.name : 'UnknownError'
      );
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(status).json({
        error: status >= 500 ? 'Internal server error.' : 'Request could not be processed.',
        code: status >= 500 ? 'api/internal-error' : 'api/request-error',
      });
    }
  );

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`DOWNLYX server listening on http://0.0.0.0:${port}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start DOWNLYX server:', err);
  process.exit(1);
});
