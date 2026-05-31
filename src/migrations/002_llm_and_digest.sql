-- M2 additions:
--   - llm_calls: per-call telemetry for cost_estimate() + parse-error visibility
--   - digest_state: tracks the cutoff timestamp of the last daily_digest run
--   - scan_runs: per scan_portals invocation summary (added in G2)

CREATE TABLE llm_calls (
  id              TEXT PRIMARY KEY,
  tool            TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  job_id          TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  input_chars     INTEGER NOT NULL,
  output_chars    INTEGER NOT NULL,
  parse_ok        INTEGER NOT NULL DEFAULT 1,
  parse_error     TEXT,
  duration_ms     INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The only reader (cost_estimate) is a time-window scan grouped by (provider, model, tool).
-- A single descending btree on created_at supports that scan; per-column ones add write
-- cost without speeding up the GROUP BY.
CREATE INDEX idx_llm_calls_created_at ON llm_calls(created_at DESC);

CREATE TABLE digest_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  last_digest_at  TEXT
);
INSERT INTO digest_state (id) VALUES (1);

CREATE TABLE scan_runs (
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at   TEXT,
  sources       TEXT,                    -- JSON array of provider ids hit
  companies_n   INTEGER NOT NULL DEFAULT 0,
  jobs_found    INTEGER NOT NULL DEFAULT 0,
  jobs_new      INTEGER NOT NULL DEFAULT 0,
  jobs_dupes    INTEGER NOT NULL DEFAULT 0,
  errors_json   TEXT,                    -- JSON array of { company, error }
  triggered_by  TEXT NOT NULL DEFAULT 'manual'
);
