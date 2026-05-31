// Thin repo around jobs + companies. Used by every tool that touches a job row.
import { randomUUID } from 'node:crypto';
import { getDb, runInWriteLock } from '../db.js';
import { contentHash } from './content_hash.js';
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

function normalizeCompanyName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function upsertCompany(name: string): string {
  const normalized = normalizeCompanyName(name);
  if (!normalized) throw new Error('upsertCompany: empty company name');
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM companies WHERE name_normalized = ?')
    .get(normalized) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO companies (id, name, name_normalized)
    VALUES (?, ?, ?)
  `).run(id, name.trim(), normalized);
  return id;
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
    const company_id = upsertCompany(input.company_name);
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

// Company lookup that tolerates name variations — normalized exact match, then LIKE.
export function findCompanyByName(query: string): { id: string; name: string } | null {
  const normalized = query.toLowerCase().trim();
  return (getDb().prepare(`
    SELECT id, name FROM companies
    WHERE name_normalized = ? OR LOWER(name) LIKE ?
    ORDER BY (name_normalized = ?) DESC
    LIMIT 1
  `).get(normalized, `%${normalized}%`, normalized) as { id: string; name: string } | undefined) ?? null;
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
