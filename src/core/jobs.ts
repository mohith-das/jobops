// Thin repo around jobs + companies. Used by every tool that touches a job row.
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb, runInWriteLock } from '../db.js';
import { contentHash } from './content_hash.js';
import { normalizeCompanyName, canonicalCompanyName } from './company_match.js';
import type { NormalizedJD } from './jd_normalize.js';

export interface JobRow {
  id:                 string;
  source:             string;
  source_job_id:      string | null;
  source_url:         string;
  content_hash:       string | null;
  company_id:         string | null;
  company_name_raw:   string;
  title:              string;
  role_category:      string | null;
  seniority:          string | null;
  location_raw:       string | null;
  description:        string | null;
  requirements:       string | null;
  sponsors_visa:      number | null;
  status:             string;
  declared_archetype: string | null;
  score_total:        number | null;
  score_resume_fit:   number | null;
  score_taste_fit:    number | null;
  score_visa_fit:     number | null;
  score_detail:       string | null;
  scored_at:          string | null;
  materials_generated_at: string | null;
  discovered_at:      string;
  updated_at:         string;
}

// ── Companies ────────────────────────────────────────────────────────────────

/**
 * Resolve a company name to a stable companies.id, creating the row on first sight.
 * Matching is fuzzy so legal-name variants collapse onto one row:
 *   1. exact match on name_normalized (lowercased, whitespace-collapsed);
 *   2. else match on the canonical key (legal suffixes / punctuation stripped) via
 *      the company_aliases table — this is what makes "ANTHROPIC PBC", "Anthropic",
 *      and "Anthropic, Inc." all land on the same row regardless of insert order;
 *   3. else insert a new company.
 * Every resolved variant is recorded in company_aliases (canonical key + the
 * source-tagged variant) so future lookups are O(1) and the provenance is auditable.
 *
 * `opts.source` tags where the variant came from ('linkedin', 'h1b', 'jd', …).
 */
export function upsertCompany(name: string, opts: { source?: string } = {}): string {
  const display    = (name ?? '').trim();
  const normalized = normalizeCompanyName(name);
  if (!normalized) throw new Error('upsertCompany: empty company name');
  const canonical = canonicalCompanyName(name) || normalized;
  const db = getDb();

  // 1. exact normalized match.
  const existing = db
    .prepare('SELECT id FROM companies WHERE name_normalized = ?')
    .get(normalized) as { id: string } | undefined;
  if (existing) {
    recordCompanyAliases(db, existing.id, display, normalized, canonical, opts.source);
    return existing.id;
  }

  // 2. canonical (fuzzy) match via the alias index.
  const aliasHit = db
    .prepare('SELECT company_id AS id FROM company_aliases WHERE alias_normalized = ? LIMIT 1')
    .get(canonical) as { id: string } | undefined;
  if (aliasHit) {
    recordCompanyAliases(db, aliasHit.id, display, normalized, canonical, opts.source);
    return aliasHit.id;
  }

  // 3. new company.
  const id = randomUUID();
  db.prepare(`
    INSERT INTO companies (id, name, name_normalized)
    VALUES (?, ?, ?)
  `).run(id, display, normalized);
  recordCompanyAliases(db, id, display, normalized, canonical, opts.source);
  return id;
}

/**
 * Record the canonical fuzzy key (so later variants resolve here) plus, when it adds
 * information, the source-tagged variant. INSERT OR IGNORE because UNIQUE(alias_normalized,
 * source) means a canonical key already owned by another company is left untouched —
 * but step 2 of upsertCompany would have matched that owner first, so we never reach here
 * for a genuine collision.
 */
function recordCompanyAliases(
  db: Database.Database,
  companyId: string,
  display: string,
  normalized: string,
  canonical: string,
  source?: string,
): void {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO company_aliases (id, company_id, alias, alias_normalized, source)
    VALUES (?, ?, ?, ?, ?)
  `);
  // The canonical key is the primary fuzzy index.
  ins.run(randomUUID(), companyId, display || canonical, canonical, 'canonical');
  // Keep the exact variant under its source for provenance when it carries more than
  // the canonical key already does.
  if (source && normalized && normalized !== canonical) {
    ins.run(randomUUID(), companyId, display || normalized, normalized, source);
  }
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export interface UpsertJobInput {
  source:        string;
  source_url:    string;
  source_job_id?: string | null;
  company_name: string;
  title:        string;
  location?:    string | null;
  description?: string | null;
  requirements?: string | null;
}

export interface UpsertJobResult { id: string; created: boolean; }

export async function upsertJob(input: UpsertJobInput): Promise<UpsertJobResult> {
  return runInWriteLock<UpsertJobResult>(() => {
    const db = getDb();
    const company_id = upsertCompany(input.company_name, { source: 'jd' });
    const hash = contentHash({
      company: input.company_name,
      title:   input.title,
      location: input.location ?? null,
    });

    // Three-way dedup: source+source_job_id, source_url, content_hash.
    let existing = db.prepare(`
      SELECT id FROM jobs WHERE content_hash = ? OR source_url = ?
    `).get(hash, input.source_url) as { id: string } | undefined;
    if (!existing && input.source_job_id) {
      existing = db.prepare(`
        SELECT id FROM jobs WHERE source = ? AND source_job_id = ?
      `).get(input.source, input.source_job_id) as { id: string } | undefined;
    }
    if (existing) {
      db.prepare(`
        UPDATE jobs SET
          description = COALESCE(?, description),
          requirements = COALESCE(?, requirements),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(input.description ?? null, input.requirements ?? null, existing.id);
      return { id: existing.id, created: false };
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO jobs (
        id, source, source_job_id, source_url, content_hash,
        company_id, company_name_raw, title, location_raw,
        description, requirements, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sourced')
    `).run(
      id,
      input.source,
      input.source_job_id ?? null,
      input.source_url,
      hash,
      company_id,
      input.company_name,
      input.title,
      input.location ?? null,
      input.description ?? null,
      input.requirements ?? null,
    );
    return { id, created: true };
  });
}

export function getJob(id: string): JobRow | null {
  return (getDb()
    .prepare('SELECT * FROM jobs WHERE id = ?')
    .get(id) as JobRow | undefined) ?? null;
}

// Shorthand for the recurring `j.* + COALESCE(c.name, j.company_name_raw)` pattern.
export interface JobWithCompany extends JobRow { company_name: string; resolved_company_id: string | null; }
export function getJobWithCompany(id: string): JobWithCompany | null {
  return (getDb().prepare(`
    SELECT j.*, COALESCE(c.name, j.company_name_raw) AS company_name, c.id AS resolved_company_id
    FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = ?
  `).get(id) as JobWithCompany | undefined) ?? null;
}

// Company lookup that tolerates name variations. Read-only (never inserts):
//   1. exact name_normalized match;
//   2. canonical (legal-suffix-stripped) match via the company_aliases index — so
//      visa_signal("ANTHROPIC PBC") finds the same row as a JD scraped as "Anthropic";
//   3. LIKE substring fallback (original behaviour) for partial queries.
export function findCompanyByName(query: string): { id: string; name: string } | null {
  const db = getDb();
  const normalized = normalizeCompanyName(query);
  if (!normalized) return null;

  const exact = db.prepare('SELECT id, name FROM companies WHERE name_normalized = ?')
    .get(normalized) as { id: string; name: string } | undefined;
  if (exact) return exact;

  const canonical = canonicalCompanyName(query) || normalized;
  const viaAlias = db.prepare(`
    SELECT c.id, c.name FROM company_aliases a
    JOIN companies c ON c.id = a.company_id
    WHERE a.alias_normalized = ?
    LIMIT 1
  `).get(canonical) as { id: string; name: string } | undefined;
  if (viaAlias) return viaAlias;

  return (db.prepare(`
    SELECT id, name FROM companies
    WHERE LOWER(name) LIKE ?
    ORDER BY length(name) ASC
    LIMIT 1
  `).get(`%${normalized}%`) as { id: string; name: string } | undefined) ?? null;
}

export function getJobCompanyName(id: string): string | null {
  const row = getDb().prepare(`
    SELECT COALESCE(c.name, j.company_name_raw) AS name
    FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
    WHERE j.id = ?
  `).get(id) as { name: string } | undefined;
  return row?.name ?? null;
}

// ── Adopt-from-paste / URL ──────────────────────────────────────────────────
//
// evaluate_job uses this when the caller hasn't given us a job_id. We need stable rows
// so the report + scores have something to attach to. Caller passes title + company best-
// guesses (chat client extracts these from the JD).

export interface AdoptJobInput {
  jd: NormalizedJD;
  title?:   string;       // chat-provided override
  company?: string;       // chat-provided override
  location?: string;
}

export async function adoptJobFromJD(input: AdoptJobInput): Promise<UpsertJobResult> {
  const title   = (input.title   ?? input.jd.title_guess   ?? 'Untitled role').trim();
  const company = (input.company ?? input.jd.company_guess ?? 'Unknown company').trim();
  return upsertJob({
    source:     input.jd.source === 'url' ? 'url' : 'paste',
    source_url: input.jd.source_url ?? `paste://${Date.now()}`,
    company_name: company,
    title,
    location: input.location ?? null,
    description: input.jd.text,
  });
}
