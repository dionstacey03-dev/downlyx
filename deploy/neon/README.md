# DOWNLYX Neon + Vercel migration

This folder is the database migration baseline for replacing Firestore
application-data persistence with Neon Postgres. It is **not** a completed
database cutover: the current API still uses Firebase Admin/Firestore in
`server/storage/userDataStore.ts`.

## Target deployment

- Vercel: Vite frontend and lightweight request/API functions only.
- Neon Postgres: user history/preferences and durable download-job records.
- Firebase Authentication: retain for identity and ID-token verification.
- Dedicated worker host/container: yt-dlp, FFmpeg, job execution and media
  file handling. Do not run long media jobs in Vercel Functions.
- Queue: Redis-compatible durable queue (e.g. Upstash Redis) or a Postgres
  queue adapter, with worker leases and retry policy.

## Database setup

1. Create a Neon project/database in the Vercel Marketplace or Neon console.
2. Apply `001_initial_schema.sql` using a migration/owner role.
3. Create a runtime role with only the required SELECT/INSERT/UPDATE/DELETE
   privileges on the DOWNLYX tables; do not use the owner credential in API
   runtime.
4. Add the runtime connection string as a server-side `DATABASE_URL` in the
   API host. Never use a `VITE_*` prefix for database credentials.
5. Keep the existing Firestore data until the migration and reconciliation
   script has copied and verified user records. Do not delete the old
   collection as part of the first deployment.

## Cutover sequence

1. Implement and test a Postgres-backed user-data adapter with transactional
   history updates and account deletion.
2. Add a one-time, resumable Firestore-to-Postgres migration that uses stable
   Firebase UIDs, preserves preferences/history, and reports counts/checksums.
3. Implement durable job state and atomic queue claiming; move completed-file
   metadata to durable storage and files to private object storage.
4. Deploy the worker service with restricted outbound networking, resource
   limits, and a queue consumer.
5. Configure the Vercel frontend's `VITE_API_BASE_URL` to the deployed API
   origin; configure that API's CORS allowlist for the exact Vercel production
   and preview origins.
6. Run authenticated smoke tests (analyze, enqueue, status, cancel, download,
   history/preferences, account deletion) before switching traffic.
7. Monitor errors and job completion, then retire Firestore only after a
   verified rollback window.

## Current status

The schema is committed as a migration foundation. The application adapter,
queue/worker integration, data migration, and production credentials still
need implementation/configuration. Vercel's Git-linked frontend project is
already present, but it currently has no project environment variables
configured. The existing frontend deployment should not be considered a
Vercel-hosted media API.
