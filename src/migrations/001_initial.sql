-- jobops initial schema.
-- Collapses the JSA Postgres schema (study guide §3) + career-ops side-tables (eval_reports,
-- story_bank, negotiation_notes) into a single SQLite file. Shapes match JSA columns so SQL
-- recipes from the study guide (§10, §12.9) port over with minimal edits.
--
-- Conventions:
--   - id: TEXT, lowercase UUIDv4 generated in app code via crypto.randomUUID()
--   - timestamps: TEXT, ISO-8601 with timezone (CURRENT_TIMESTAMP yields 'YYYY-MM-DD HH:MM:SS')
--   - JSONB → TEXT (parsed in app); accessed via SQLite json_*() functions for views
--   - booleans → INTEGER 0/1
-- Status columns use CHECK constraints (canonical states from the brief + JSA + career-ops).

PRAGMA foreign_keys = ON;

-- ──────────────────────────────────────────────────────────────────────────────
-- companies
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE companies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  name_normalized TEXT NOT NULL UNIQUE,
  website         TEXT,
  linkedin_url    TEXT,
  hq_city         TEXT,
  hq_country      TEXT,
  headcount_range TEXT,
  funding_stage   TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_companies_name_normalized ON companies(name_normalized);

-- ──────────────────────────────────────────────────────────────────────────────
-- company_aliases — alternate spellings (LinkedIn / DOL / etc.)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE company_aliases (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alias            TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  source           TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (alias_normalized, source)
);

CREATE INDEX idx_company_aliases_alias_norm  ON company_aliases(alias_normalized);
CREATE INDEX idx_company_aliases_company_id  ON company_aliases(company_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- target_companies — what the pollers actually scrape
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE target_companies (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  greenhouse_slug TEXT,
  ashby_slug      TEXT,
  lever_slug      TEXT,
  workday_url     TEXT,
  careers_url     TEXT,
  priority        INTEGER NOT NULL DEFAULT 2,
  is_active       INTEGER NOT NULL DEFAULT 1,
  last_polled_at  TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_target_companies_active ON target_companies(is_active);

-- ──────────────────────────────────────────────────────────────────────────────
-- jobs — main table; status state machine matches the brief exactly
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE jobs (
  id                    TEXT PRIMARY KEY,
  source                TEXT NOT NULL,             -- greenhouse | ashby | lever | workday | manual | paste | ...
  source_job_id         TEXT,
  source_url            TEXT NOT NULL,
  content_hash          TEXT UNIQUE,
  company_id            TEXT REFERENCES companies(id),
  company_name_raw      TEXT NOT NULL,
  title                 TEXT NOT NULL,
  role_category         TEXT,                      -- pm | ml_eng | data_eng | analytics_eng | swe | forward_deployed | other
  seniority             TEXT,                      -- intern | junior | mid | senior | staff | principal | lead | unclear
  location_raw          TEXT,
  location_city         TEXT,
  location_region       TEXT,
  location_country      TEXT,
  is_remote             INTEGER,
  is_hybrid             INTEGER,
  comp_min_usd          INTEGER,
  comp_max_usd          INTEGER,
  comp_currency         TEXT DEFAULT 'USD',
  description           TEXT,
  description_html      TEXT,
  requirements          TEXT,
  sponsors_visa         INTEGER,
  visa_signal_source    TEXT,
  visa_notes            TEXT,
  status                TEXT NOT NULL DEFAULT 'sourced'
                          CHECK (status IN (
                            'sourced','ready_to_apply','materials_drafted','ready_to_review',
                            'applied','screen','onsite','offer','rejected','discarded','skip'
                          )),
  declared_archetype    TEXT,                      -- optional user override of role_category for scoring
  score_total           INTEGER,                   -- 0..100
  score_resume_fit      INTEGER,
  score_taste_fit       INTEGER,
  score_visa_fit        INTEGER,
  score_detail          TEXT,                      -- JSON: reasoning, concerns, parse_error, raw
  scored_at             TEXT,
  materials_generated_at TEXT,
  applied_at            TEXT,
  posted_at             TEXT,
  discovered_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source, source_job_id)
);

CREATE INDEX idx_jobs_company_id    ON jobs(company_id);
CREATE INDEX idx_jobs_status        ON jobs(status);
CREATE INDEX idx_jobs_score_total   ON jobs(score_total DESC);
CREATE INDEX idx_jobs_discovered_at ON jobs(discovered_at DESC);
CREATE INDEX idx_jobs_role_category ON jobs(role_category);
CREATE INDEX idx_jobs_location_ctry ON jobs(location_country);

-- ──────────────────────────────────────────────────────────────────────────────
-- linkedin_connections — imported network
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE linkedin_connections (
  id                  TEXT PRIMARY KEY,
  first_name          TEXT,
  last_name           TEXT,
  full_name           TEXT,
  email               TEXT,
  linkedin_url        TEXT UNIQUE,
  twitter_url         TEXT,
  company_id          TEXT REFERENCES companies(id),
  company_raw         TEXT,
  position            TEXT,
  seniority_inferred  TEXT,
  is_recruiter        INTEGER NOT NULL DEFAULT 0,
  is_engineering      INTEGER NOT NULL DEFAULT 0,
  is_leadership       INTEGER NOT NULL DEFAULT 0,
  preferred_channel   TEXT DEFAULT 'linkedin',
  outreach_notes      TEXT,
  notes               TEXT,
  connected_on        TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_li_company_id   ON linkedin_connections(company_id);
CREATE INDEX idx_li_full_name    ON linkedin_connections(full_name);
CREATE INDEX idx_li_position     ON linkedin_connections(position);
CREATE INDEX idx_li_is_recruiter ON linkedin_connections(is_recruiter);

-- ──────────────────────────────────────────────────────────────────────────────
-- h1b_filings — DOL OFLC quarterly data
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE h1b_filings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  case_number         TEXT NOT NULL UNIQUE,
  case_status         TEXT NOT NULL,
  visa_class          TEXT,
  employer_id         TEXT REFERENCES companies(id),
  employer_name_raw   TEXT NOT NULL,
  job_title           TEXT,
  soc_code            TEXT,
  soc_title           TEXT,
  work_city           TEXT,
  work_state          TEXT,
  work_postal_code    TEXT,
  wage_rate_from      REAL,
  wage_rate_to        REAL,
  wage_unit           TEXT,
  prevailing_wage     REAL,
  received_date       TEXT,
  decision_date       TEXT,
  employment_start    TEXT,
  employment_end      TEXT,
  full_time           INTEGER,
  new_employment      INTEGER,
  fiscal_year         INTEGER NOT NULL,
  raw_json            TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_h1b_employer_id     ON h1b_filings(employer_id);
CREATE INDEX idx_h1b_employer_raw    ON h1b_filings(employer_name_raw);
CREATE INDEX idx_h1b_soc_code        ON h1b_filings(soc_code);
CREATE INDEX idx_h1b_decision_date   ON h1b_filings(decision_date DESC);
CREATE INDEX idx_h1b_fiscal_year     ON h1b_filings(fiscal_year);
CREATE INDEX idx_h1b_case_status     ON h1b_filings(case_status);

-- ──────────────────────────────────────────────────────────────────────────────
-- outreach — every warm-intro / founder DM lives here
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE outreach (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT REFERENCES linkedin_connections(id) ON DELETE SET NULL,
  company_id          TEXT REFERENCES companies(id),
  related_job_id      TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  outreach_type       TEXT NOT NULL
                        CHECK (outreach_type IN ('warm_intro_request','founder_dm','recruiter_followup','generic','followup')),
  channel             TEXT NOT NULL DEFAULT 'linkedin',
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','drafted','edited','sent','replied','dead','success')),
  draft_message       TEXT,
  edited_message      TEXT,
  subject_line        TEXT,
  reply_text          TEXT,
  notes               TEXT,
  sent_at             TEXT,
  replied_at          TEXT,
  followup_due_at     TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_outreach_status         ON outreach(status);
CREATE INDEX idx_outreach_connection     ON outreach(connection_id);
CREATE INDEX idx_outreach_followup_due   ON outreach(followup_due_at);
CREATE INDEX idx_outreach_company        ON outreach(company_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- applications — one per (job × materials version)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE applications (
  id                    TEXT PRIMARY KEY,
  job_id                TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'materials_drafted'
                          CHECK (status IN (
                            'materials_drafted','render_error','ready_to_review','applied','screen',
                            'onsite','offer','rejected','discarded'
                          )),
  tailored_bullets      TEXT,                       -- JSON: { tagline, experience_bullets: {<employer_slug>: [...]}, projects_section, skills_section }
  cover_letter_draft    TEXT,                       -- plain prose, 250-350 words
  tailoring_notes       TEXT,
  resume_path           TEXT,                       -- path under output/ (returned as localhost link)
  cover_path            TEXT,
  resume_tex            TEXT,
  cover_letter_tex      TEXT,
  materials_v           INTEGER NOT NULL DEFAULT 1,
  last_status_change_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ──────────────────────────────────────────────────────────────────────────────
-- enrichment — Brave / web research summaries with 30-day TTL
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE enrichment (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('comp','culture','recent_news')),
  raw_search_results  TEXT,                          -- JSON
  summary             TEXT,
  confidence_score    INTEGER,                       -- 0..100
  signal_quality      TEXT,                          -- strong | mixed | weak | none
  flags               TEXT,
  source_urls         TEXT,                          -- JSON array
  expires_at          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, kind)
);

CREATE INDEX idx_enrichment_expires_at ON enrichment(expires_at);

-- ──────────────────────────────────────────────────────────────────────────────
-- career_packet — single is_active row; full version history retained
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE career_packet (
  id              TEXT PRIMARY KEY,
  version         INTEGER NOT NULL,
  content         TEXT NOT NULL,                     -- markdown source-of-truth packet
  taglines        TEXT,                              -- JSON array of alternates
  is_active       INTEGER NOT NULL DEFAULT 0,
  source_cv_hash  TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_career_packet_active ON career_packet(is_active);

-- ──────────────────────────────────────────────────────────────────────────────
-- contacts — company-level contact discovery (people without LinkedIn rows)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE contacts (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name    TEXT,
  email        TEXT,
  role         TEXT,
  source       TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ──────────────────────────────────────────────────────────────────────────────
-- eval_reports — career-ops 6-block report (A–F) persisted; G is in score_detail
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE eval_reports (
  id                  TEXT PRIMARY KEY,
  job_id              TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL CHECK (mode IN ('chat','api')),
  archetype_detected  TEXT,
  block_role_summary  TEXT,        -- A
  block_cv_match      TEXT,        -- B
  block_level         TEXT,        -- C
  block_comp          TEXT,        -- D
  block_personalize   TEXT,        -- E
  block_interview     TEXT,        -- F
  block_legitimacy    TEXT,        -- G (career-ops) — optional, populated when chat fills it
  keywords            TEXT,        -- JSON array
  raw_input           TEXT,        -- normalized JD text passed to chat
  html_path           TEXT,        -- under output/, served via /files/
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_eval_reports_job ON eval_reports(job_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- story_bank — STAR + Reflection stories distilled across evaluations
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE story_bank (
  id                TEXT PRIMARY KEY,
  job_id            TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  story_text        TEXT NOT NULL,
  reflection        TEXT,
  competency_tags   TEXT,                    -- JSON array
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_story_bank_job ON story_bank(job_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- negotiation_notes — per-offer negotiation worksheet
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE negotiation_notes (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  framework     TEXT,
  leverage      TEXT,
  geo_pushback  TEXT,
  comp_target   TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ──────────────────────────────────────────────────────────────────────────────
-- scheduler_state — single-row table for opt-in cron job enable/disable
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE scheduler_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  enabled_jobs  TEXT NOT NULL DEFAULT '[]',         -- JSON array of job names
  last_run_at   TEXT,
  notes         TEXT
);
INSERT INTO scheduler_state (id, enabled_jobs) VALUES (1, '[]');

-- ──────────────────────────────────────────────────────────────────────────────
-- Views — JSA views recreated against SQLite (study guide §3.3)
-- ──────────────────────────────────────────────────────────────────────────────

CREATE VIEW v_rated_jobs AS
SELECT
  j.id AS job_id,
  j.title,
  c.name AS company_name,
  j.location_raw AS location,
  j.role_category,
  j.seniority,
  j.score_total,
  j.score_resume_fit,
  j.score_taste_fit,
  j.score_visa_fit,
  j.status,
  j.source_url,
  j.discovered_at,
  j.scored_at
FROM jobs j
LEFT JOIN companies c ON c.id = j.company_id
WHERE j.score_total IS NOT NULL;

CREATE VIEW v_top_jobs AS
SELECT * FROM v_rated_jobs
WHERE score_total >= 75
ORDER BY score_total DESC, discovered_at DESC;

CREATE VIEW v_apply_ready AS
SELECT
  j.id AS job_id,
  j.title,
  c.name AS company_name,
  j.score_total,
  j.role_category,
  j.location_raw AS location,
  j.source_url,
  j.status,
  a.id AS application_id,
  a.resume_path,
  a.cover_path,
  a.materials_v,
  a.last_status_change_at
FROM jobs j
LEFT JOIN companies c ON c.id = j.company_id
LEFT JOIN applications a ON a.job_id = j.id
WHERE j.status IN ('ready_to_apply','materials_drafted','ready_to_review');

CREATE VIEW v_active_pipeline AS
SELECT
  j.id AS job_id,
  c.name AS company_name,
  j.title,
  j.status,
  j.score_total,
  j.applied_at,
  a.last_status_change_at
FROM jobs j
LEFT JOIN companies c ON c.id = j.company_id
LEFT JOIN applications a ON a.job_id = j.id
WHERE j.status IN ('applied','screen','onsite','offer')
ORDER BY a.last_status_change_at DESC NULLS LAST, j.applied_at DESC;

CREATE VIEW v_company_h1b_signal AS
SELECT
  c.id   AS company_id,
  c.name AS company_name,
  COUNT(h.id)                                                  AS total_filings,
  SUM(CASE WHEN h.case_status = 'Certified' THEN 1 ELSE 0 END) AS certified_count,
  MAX(h.decision_date)                                         AS last_decision_date,
  MAX(h.fiscal_year)                                           AS most_recent_fy
FROM companies c
LEFT JOIN h1b_filings h ON h.employer_id = c.id
GROUP BY c.id, c.name;

-- Warm-intro pairing — job × non-recruiter connection at the same company.
-- contact_priority: 1=engineering peer, 2=leadership, 3=other; recruiters routed
-- separately so they're not in this view.
CREATE VIEW v_jobs_with_warm_intros AS
SELECT
  j.id                 AS job_id,
  c.id                 AS company_id,
  c.name               AS company_name,
  j.title              AS job_title,
  j.score_total,
  lc.id                AS connection_id,
  lc.full_name         AS connection_name,
  lc.position          AS connection_position,
  CASE
    WHEN lc.is_engineering = 1 THEN 1
    WHEN lc.is_leadership  = 1 THEN 2
    ELSE 3
  END                   AS contact_priority
FROM jobs j
JOIN companies c ON c.id = j.company_id
JOIN linkedin_connections lc ON lc.company_id = c.id
WHERE lc.is_recruiter = 0
ORDER BY j.score_total DESC, contact_priority ASC;

-- Founder network — derives founder_kind via simple position substring match.
-- is_stealth: 1 when company_raw mentions stealth (we don't drop, we flag).
CREATE VIEW v_founder_network AS
SELECT
  lc.id           AS connection_id,
  lc.full_name,
  lc.position,
  lc.company_raw,
  lc.company_id,
  CASE
    WHEN LOWER(lc.position) LIKE '%founder%'  THEN 'founder'
    WHEN LOWER(lc.position) LIKE '%ceo%'      THEN 'ceo'
    WHEN LOWER(lc.position) LIKE '%cto%'      THEN 'cto'
    WHEN LOWER(lc.position) LIKE '%chief%'    THEN 'c_suite'
    ELSE 'other'
  END             AS founder_kind,
  CASE
    WHEN LOWER(COALESCE(lc.company_raw,'')) LIKE '%stealth%' THEN 1 ELSE 0
  END             AS is_stealth
FROM linkedin_connections lc
WHERE lc.is_leadership = 1
   OR LOWER(lc.position) LIKE '%founder%'
   OR LOWER(lc.position) LIKE '%ceo%'
   OR LOWER(lc.position) LIKE '%cto%'
   OR LOWER(lc.position) LIKE '%chief%';

CREATE VIEW v_followups_due AS
SELECT
  o.id            AS outreach_id,
  o.connection_id,
  lc.full_name    AS connection_name,
  c.name          AS company_name,
  o.outreach_type,
  o.status,
  o.sent_at,
  o.followup_due_at
FROM outreach o
LEFT JOIN linkedin_connections lc ON lc.id = o.connection_id
LEFT JOIN companies c ON c.id = o.company_id
WHERE o.status = 'sent'
  AND o.followup_due_at IS NOT NULL
  AND o.followup_due_at <= CURRENT_TIMESTAMP;
