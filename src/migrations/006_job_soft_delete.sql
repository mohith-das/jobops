-- 006: soft-delete (trash) for jobs. `trashed_at` is an orthogonal recoverable flag — NOT a
-- status value (skip/discard are triage outcomes; trash is "deleted, recoverable"). Trashed
-- jobs are excluded from the tracker / top-jobs / batch views but retained in the row; the
-- job's `status` is left untouched so restore returns it to its prior state automatically.
-- Hard removal is only via the explicit, backup-first purge path.

ALTER TABLE jobs ADD COLUMN trashed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_trashed ON jobs(trashed_at);
