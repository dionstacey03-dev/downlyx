# DOWNLYX deployment notes

## Current architecture

The web UI is a Vite build. The API is the Express application in `server.ts`
and is **not** a Vercel serverless function. The frontend accepts a separate API
origin through `VITE_API_BASE_URL`; the backend allowlists cross-origin browser
requests using `DOWNLYX_ALLOWED_ORIGINS`. The API owns an in-process
`MediaWorkerManager` and launches local worker child processes. The API's worker manager starts local child processes inside the API container.
The separate worker image is a child-process runner that expects a job payload
on stdin; without a queue/IPC adapter it cannot act as a standalone service.
The Compose stack therefore does not start a no-op worker container.

## Build and run the API container

The repository-root `Dockerfile` builds the frontend and runs the Express API
using Bun. It includes FFmpeg because the current worker manager starts local
child processes inside the API container.

1. Set a strong random `DOWNLYX_SESSION_SECRET` (at least 32 bytes).
2. Set `VITE_FIREBASE_API_KEY` to the web API key from Firebase Project
   Settings → General → Your apps. This is a public client configuration value;
   restrict it with API-key and Firebase authorized-domain settings.
3. Set `FIREBASE_PROJECT_ID` explicitly and enable Firebase Authentication
   and Cloud Firestore in that project. The API stores account history and
   preferences in the `downlyxUserData` collection using Firebase Admin
   transactions; server-side Admin access bypasses client Firestore rules.
4. Provide Firebase Admin Application Default Credentials. For local Compose,
   create an untracked `firebase-admin.json` service-account file and ensure
   it has the required Auth and Firestore permissions. Never commit it.
5. Build and run with a container platform that supports read-only root files,
   tmpfs, CPU/memory/PID limits, and secret mounts.
6. Keep `TRUST_PROXY=false` unless the API is reachable only through a trusted
   reverse proxy/load balancer that overwrites forwarding headers. If deployed
   behind such a proxy, configure the correct hop count rather than blindly
   trusting client-supplied `X-Forwarded-For` headers.

Example local build:

```sh
docker build \
  --build-arg VITE_FIREBASE_API_KEY="$VITE_FIREBASE_API_KEY" \
  --build-arg VITE_API_BASE_URL="$VITE_API_BASE_URL" \
  -t downlyx-api .
```

When the frontend and API are hosted separately, set the Vercel Production
environment variable `VITE_API_BASE_URL` to the API origin (no trailing path),
and set `DOWNLYX_ALLOWED_ORIGINS` on the API to the exact frontend origin,
such as `https://your-app.vercel.app`. The API includes an explicit CORS
allowlist; it intentionally rejects unconfigured browser origins.

The Compose file expects the local untracked `firebase-admin.json` file and
the session secret to be supplied. It intentionally fails fast when required
credentials are absent.

## Important remaining production work

User history and preferences are persisted in Firestore. Download job
state, active queue reservations, and completed-file metadata are still held by
the API process and local temporary storage. A process restart or horizontal
scale-out can lose active job state; a durable queue/job database is still
required for reliable multi-instance production processing.

The current manager does not dispatch jobs to the standalone worker container.
True network-isolated media processing requires a queue/IPC contract, durable
job state, and a worker service that consumes jobs and returns results. The
current process-level worker limits do not provide a separate network namespace.
Do not expose the API as production-ready for arbitrary untrusted URL processing
until the queue/worker architecture and its egress policy are enforced at runtime.

Vercel's static frontend deployment alone does not host the Express API or
FFmpeg worker. Configure a separately hosted API origin and route frontend
`/api/*` requests to it before using authentication or downloads.
