# DOWNLYX deployment notes

## Current architecture

The web UI is a Vite build. The API is the Express application in `server.ts`
and is **not** a Vercel serverless function. The API owns an in-process
`MediaWorkerManager` and launches local worker child processes. The standalone
`downlyx-media-worker` Compose service is not connected to the API's job
manager or queue; do not treat it as the worker executing API jobs.

## Build and run the API container

The repository-root `Dockerfile` builds the frontend and runs the Express API
using Bun. It includes FFmpeg because the current worker manager starts local
child processes inside the API container.

1. Set a strong random `DOWNLYX_SESSION_SECRET` (at least 32 bytes).
2. Set `VITE_FIREBASE_API_KEY` to the web API key from Firebase Project
   Settings → General → Your apps. This is a public client configuration value;
   restrict it with API-key and Firebase authorized-domain settings.
3. Provide Firebase Admin Application Default Credentials. For local Compose,
   create an untracked `firebase-admin.json` service-account file and ensure
   it has only the required Firebase Auth permissions. Never commit it.
4. Build and run with a container platform that supports read-only root files,
   tmpfs, CPU/memory/PID limits, and secret mounts.

Example local build:

```sh
docker build --build-arg VITE_FIREBASE_API_KEY="$VITE_FIREBASE_API_KEY" -t downlyx-api .
```

The Compose file expects the local untracked `firebase-admin.json` file and
the session secret to be supplied. It intentionally fails fast when required
credentials are absent.

## Important remaining production work

The current manager does not dispatch jobs to the standalone worker container.
True network-isolated media processing requires a queue/IPC contract, a
persistent job store, and a worker service that consumes jobs and returns
results. Do not expose the API as production-ready for untrusted URLs until
that architecture is implemented and its egress policy is enforced at runtime.

Vercel's static frontend deployment alone does not host the Express API or
FFmpeg worker. Configure a separately hosted API origin and route frontend
`/api/*` requests to it before using authentication or downloads.
