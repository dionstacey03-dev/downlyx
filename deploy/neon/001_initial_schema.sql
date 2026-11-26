-- DOWNLYX Neon/Postgres migration baseline.
-- Apply with a privileged migration role before configuring DATABASE_URL.
-- API runtime uses a separate least-privilege role; never expose this URL to Vite.

CREATE TABLE IF NOT EXISTS downlyx_user_data (
  user_id TEXT PRIMARY KEY,
  history JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(history) = 'array'),
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(preferences) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS downlyx_download_jobs (
  job_id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'processing', 'verifying', 'completed', 'failed', 'cancelled')
  ),
  request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  progress JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(progress) = 'object'),
  result JSONB,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS downlyx_jobs_owner_created_idx
  ON downlyx_download_jobs (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS downlyx_jobs_queue_idx
  ON downlyx_download_jobs (created_at ASC)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS downlyx_jobs_expiry_idx
  ON downlyx_download_jobs (expires_at)
  WHERE expires_at IS NOT NULL;
