# DOWNLYX

DOWNLYX is a media utility web application for analyzing URLs and securely processing user-owned or authorized media from supported platforms and direct media links.

## Technology

- React, TypeScript, Vite, and Tailwind CSS
- Express API
- Firebase Authentication for identity and ID-token verification
- Firestore for account history and preferences in the current backend
- FFmpeg/FFprobe and isolated child processes for media processing
- Docker for API deployment

## Development

Requirements: Node.js, Bun, FFmpeg/FFprobe, and Firebase project configuration for authenticated API workflows.

```bash
bun install --frozen-lockfile
bun run dev
```

The development server runs the Express API and frontend development workflow as configured by the repository.

## Validation

```bash
bun run lint
bun run test
bun run build
```

The test suite includes URL validation, authentication emulator integration, user isolation, download worker behavior, and security regression tests.

## Configuration

See [deployment notes](deploy/README.md) for API environment variables, Firebase Admin credentials, trusted proxy configuration, CORS, and container deployment.

Never commit service-account credentials, signing secrets, or production database credentials. Client Firebase configuration is public by design, but API keys must be restricted in the Firebase/Google Cloud console.

## Vercel and Neon migration status

Vercel is currently configured for the static Vite frontend. It does not run the Express API or the FFmpeg worker. The API must be deployed separately and configured through `VITE_API_BASE_URL`.

The Neon SQL files are a migration foundation, not a completed database cutover. The current runtime data adapter still uses Firestore. Follow [the Neon migration plan](deploy/neon/README.md) before switching production data storage.

## Production readiness

The current media worker and download state are process/local-storage based. Do not treat the service as horizontally scalable or fully production-ready for arbitrary external URLs until durable job storage, a queue, private object storage, worker network egress isolation, and authenticated deployment smoke tests are implemented.

DOWNLYX is intended for content the user owns or is authorized to access. Respect platform terms and applicable copyright law.
