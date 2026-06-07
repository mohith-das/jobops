-- 005: soft-delete for contacts. A deleted contact is archived (archived_at set), not
-- removed — it disappears from warm-intro / founder discovery but stays recoverable in the
-- row. The two discovery views are recreated to exclude archived rows.

ALTER TABLE linkedin_connections ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_li_archived ON linkedin_connections(archived_at);

-- Recreate the warm-intro view with the archived filter (views can't be ALTERed).
DROP VIEW IF EXISTS v_jobs_with_warm_intros;
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
WHERE lc.is_recruiter = 0 AND lc.archived_at IS NULL
ORDER BY j.score_total DESC, contact_priority ASC;

-- Recreate the founder-network view with the archived filter.
DROP VIEW IF EXISTS v_founder_network;
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
WHERE lc.archived_at IS NULL
  AND ( lc.is_leadership = 1
     OR LOWER(lc.position) LIKE '%founder%'
     OR LOWER(lc.position) LIKE '%ceo%'
     OR LOWER(lc.position) LIKE '%cto%'
     OR LOWER(lc.position) LIKE '%chief%' );
