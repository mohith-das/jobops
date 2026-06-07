// Network-contact upserts shared by the bulk CSV path (import_linkedin) and the chat path
// (add_contacts). Contacts live in `linkedin_connections` — the same table find_warm_intros
// and find_founders read — so anything added here is immediately discoverable there.
//
// Company names are resolved through the SAME fuzzy alias/normalization as everywhere else
// (core/jobs.ts upsertCompany: strip Inc/LLC/PBC/Ltd/Corp/…, lowercase, trim) so a contact
// at "ANTHROPIC PBC" lands on the same company row as a job scraped as "Anthropic".

import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../config.js';
import { getDb, runInWriteLock } from '../db.js';
import { upsertCompany, findCompanyByName } from './jobs.js';
import { parseCsv, rowsToObjects, expandUserPath } from './csv.js';

// Title → role flags. Same families used by import_linkedin so both paths classify identically.
export interface ClassifyFlags { is_recruiter: number; is_engineering: number; is_leadership: number; }
export function classifyTitle(title: string | undefined | null): ClassifyFlags {
  const t = (title ?? '').toLowerCase();
  return {
    is_recruiter:   /(recruit|talent|sourcer|head of talent)/i.test(t) ? 1 : 0,
    is_engineering: /(engineer|developer|swe|sre|ml|data|backend|frontend|fullstack|platform)/i.test(t) ? 1 : 0,
    is_leadership:  /(chief|founder|ceo|cto|cpo|cmo|vp|director|head of|principal)/i.test(t) ? 1 : 0,
  };
}

export interface ContactInput {
  full_name?:      string;
  company?:        string;
  position?:       string;   // a.k.a. title (the tool accepts both and maps title→position)
  linkedin_url?:   string;
  email?:          string;
  notes?:          string;
  is_recruiter?:   boolean;
  is_engineering?: boolean;
  is_leadership?:  boolean;
}

export interface ContactResult {
  full_name:        string;
  action:           'inserted' | 'updated' | 'skipped';
  resolved_company: string | null;   // canonical company name the contact resolved to
  unresolved:       string[];         // gaps the chat may want to fill (no linkedin_url, company unmatched, …)
  reason?:          string;           // why a row was skipped
}

export interface AddContactsSummary {
  total:    number;
  inserted: number;
  updated:  number;
  skipped:  number;
  results:  ContactResult[];
}

const trimOrNull = (s: string | undefined | null): string | null => {
  const v = (s ?? '').trim();
  return v ? v : null;
};

/**
 * Upsert 1..N contacts into linkedin_connections in ONE serialized write transaction.
 * Per contact: match on linkedin_url if present, else full_name + resolved company; insert
 * if new, merge (COALESCE — never null an omitted field) if matched. Invalid rows (no
 * full_name) are skipped + reported, never failing the batch.
 */
export async function addContacts(contacts: ContactInput[]): Promise<AddContactsSummary> {
  return runInWriteLock(() => {
    const db = getDb();
    const tx = db.transaction(() => {
      const insertStmt = db.prepare(`
        INSERT INTO linkedin_connections (
          id, first_name, last_name, full_name, email, linkedin_url,
          company_id, company_raw, position, notes,
          is_recruiter, is_engineering, is_leadership
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Merge-don't-clobber: every optional field is COALESCE'd so omitting it keeps the
      // stored value. full_name is always provided (it's the required key).
      const updateStmt = db.prepare(`
        UPDATE linkedin_connections SET
          full_name      = ?,
          first_name     = COALESCE(NULLIF(?, ''), first_name),
          last_name      = COALESCE(NULLIF(?, ''), last_name),
          email          = COALESCE(?, email),
          linkedin_url   = COALESCE(?, linkedin_url),
          company_id     = COALESCE(?, company_id),
          company_raw    = COALESCE(?, company_raw),
          position       = COALESCE(NULLIF(?, ''), position),
          notes          = COALESCE(?, notes),
          is_recruiter   = COALESCE(?, is_recruiter),
          is_engineering = COALESCE(?, is_engineering),
          is_leadership  = COALESCE(?, is_leadership),
          updated_at     = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      const byUrl  = db.prepare(`SELECT id FROM linkedin_connections WHERE linkedin_url = ?`);
      const byName = db.prepare(`SELECT id FROM linkedin_connections WHERE LOWER(full_name) = LOWER(?) AND company_id IS ?`);
      const compName = db.prepare(`SELECT name FROM companies WHERE id = ?`);

      const results: ContactResult[] = [];
      let inserted = 0, updated = 0, skipped = 0;

      for (const c of contacts) {
        const full_name = (c.full_name ?? '').trim();
        if (!full_name) {
          skipped++;
          results.push({ full_name: (c.full_name ?? '').trim(), action: 'skipped', resolved_company: null,
            unresolved: ['full_name'], reason: 'missing full_name (required) — row skipped' });
          continue;
        }

        const position     = trimOrNull(c.position);
        const linkedin_url = trimOrNull(c.linkedin_url);
        const email        = trimOrNull(c.email);
        const notes        = trimOrNull(c.notes);
        const companyRaw   = trimOrNull(c.company);
        const unresolved: string[] = [];

        // Resolve the company through the shared fuzzy matcher.
        let company_id: string | null = null;
        let resolved_company: string | null = null;
        if (companyRaw) {
          const preexisting = findCompanyByName(companyRaw);   // before upsert: was it already known?
          try { company_id = upsertCompany(companyRaw, { source: 'manual' }); } catch { /* ignore */ }
          if (company_id) {
            resolved_company = (compName.get(company_id) as { name: string } | undefined)?.name ?? companyRaw;
            if (!preexisting) unresolved.push(`company "${companyRaw}" did not match a known company row (a new one was created)`);
          } else {
            unresolved.push(`company "${companyRaw}" could not be resolved`);
          }
        } else {
          unresolved.push('no company');
        }
        if (!linkedin_url) unresolved.push('no linkedin_url');
        if (!email)        unresolved.push('no email');

        // Classification: caller-provided flag wins; else infer from title (only when a title
        // was given — no title means "no signal", so on update we keep the existing flag).
        const inf = classifyTitle(position);
        const hasTitle = !!position;
        const flag = (provided: boolean | undefined, inferred: number): number | null =>
          provided !== undefined ? (provided ? 1 : 0) : (hasTitle ? inferred : null);
        const is_recruiter   = flag(c.is_recruiter,   inf.is_recruiter);
        const is_engineering = flag(c.is_engineering, inf.is_engineering);
        const is_leadership  = flag(c.is_leadership,  inf.is_leadership);

        const parts = full_name.split(/\s+/);
        const first = parts[0] ?? '';
        const last  = parts.slice(1).join(' ');

        // Match: linkedin_url first (unique), else full_name + resolved company.
        const hit = (linkedin_url
          ? byUrl.get(linkedin_url)
          : byName.get(full_name, company_id)) as { id: string } | undefined;

        if (hit) {
          updateStmt.run(full_name, first, last, email, linkedin_url, company_id, companyRaw,
                         position, notes, is_recruiter, is_engineering, is_leadership, hit.id);
          updated++;
          results.push({ full_name, action: 'updated', resolved_company, unresolved });
        } else {
          insertStmt.run(randomUUID(), first, last, full_name, email, linkedin_url, company_id, companyRaw,
                         position, notes, is_recruiter ?? 0, is_engineering ?? 0, is_leadership ?? 0);
          inserted++;
          results.push({ full_name, action: 'inserted', resolved_company, unresolved });
        }
      }
      return { total: contacts.length, inserted, updated, skipped, results };
    });
    return tx();
  });
}

// ── Export / backup (full-fidelity snapshot of every contact + field) ─────────

const EXPORT_COLUMNS = [
  'id', 'full_name', 'first_name', 'last_name', 'email', 'linkedin_url',
  'company_id', 'company', 'company_raw', 'position',
  'is_recruiter', 'is_engineering', 'is_leadership', 'notes', 'connected_on',
  'archived_at', 'created_at', 'updated_at',
] as const;

function allContactRows(): Record<string, unknown>[] {
  // Includes archived rows so an export is a complete backup (round-trip restores everything).
  return getDb().prepare(`
    SELECT lc.id, lc.full_name, lc.first_name, lc.last_name, lc.email, lc.linkedin_url,
           lc.company_id, c.name AS company, lc.company_raw, lc.position,
           lc.is_recruiter, lc.is_engineering, lc.is_leadership, lc.notes, lc.connected_on,
           lc.archived_at, lc.created_at, lc.updated_at
    FROM linkedin_connections lc
    LEFT JOIN companies c ON c.id = lc.company_id
    ORDER BY lc.full_name
  `).all() as Record<string, unknown>[];
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows: Record<string, unknown>[]): string {
  const header = EXPORT_COLUMNS.join(',');
  if (!rows.length) return `${header}\n`;
  return `${header}\n${rows.map(r => EXPORT_COLUMNS.map(c => csvCell(r[c])).join(',')).join('\n')}\n`;
}
function tsStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

export interface ExportResult { csv_path: string; json_path: string; count: number; }

/** Write ALL contacts (every field) to timestamped CSV + JSON in the project root. */
export function exportContacts(): ExportResult {
  const rows = allContactRows();
  const ts = tsStamp();
  const csv_path  = resolve(config.projectRoot, `contacts_export_${ts}.csv`);
  const json_path = resolve(config.projectRoot, `contacts_export_${ts}.json`);
  writeFileSync(csv_path,  toCsv(rows), 'utf-8');
  writeFileSync(json_path, JSON.stringify(rows, null, 2), 'utf-8');
  return { csv_path, json_path, count: rows.length };
}

/** Timestamped JSON snapshot of every contact row, written BEFORE any destructive op. */
export function backupContacts(reason: string): { path: string; count: number } {
  const rows = allContactRows();
  const path = resolve(config.projectRoot, `contacts_backup_${reason}_${tsStamp()}.json`);
  writeFileSync(path, JSON.stringify(rows, null, 2), 'utf-8');
  return { path, count: rows.length };
}

// ── Import (upsert/merge — never delete-and-replace) ──────────────────────────

const asStr = (v: unknown): string | undefined => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s ? s : undefined;
};
function coerceBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : undefined;
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (['1', 'true', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'n'].includes(s)) return false;
  return undefined;
}

export interface ImportResult {
  source: string; backup_path: string; parsed_rows: number; summary: AddContactsSummary;
}

/**
 * Import contacts from a JSON or CSV file (e.g. a prior export). UPSERT/MERGE only — never
 * delete-and-replace: matches existing rows and COALESCE-merges (blank/absent fields never
 * overwrite richer existing data), inserts new ones. Idempotent: re-importing an export
 * reproduces the same DB with zero duplicates and zero loss. A backup is written first.
 */
export async function importContacts(filePath: string): Promise<ImportResult> {
  const file = expandUserPath(filePath);
  if (!existsSync(file)) throw new Error(`file not found: ${file}`);
  const raw = readFileSync(file, 'utf-8');
  let objects: Record<string, unknown>[];
  if (/\.json$/i.test(file)) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('JSON import must be an array of contact objects');
    objects = parsed as Record<string, unknown>[];
  } else {
    objects = rowsToObjects(parseCsv(raw)) as unknown as Record<string, unknown>[];
  }

  // Backup BEFORE writing anything (bulk import could touch many rows).
  const backup = backupContacts('preimport');

  const inputs: ContactInput[] = objects.map(o => ({
    full_name:      asStr(o.full_name),
    company:        asStr(o.company) ?? asStr(o.company_raw),
    position:       asStr(o.position) ?? asStr(o.title),
    linkedin_url:   asStr(o.linkedin_url),
    email:          asStr(o.email),
    notes:          asStr(o.notes),
    is_recruiter:   coerceBool(o.is_recruiter),
    is_engineering: coerceBool(o.is_engineering),
    is_leadership:  coerceBool(o.is_leadership),
  }));

  const summary = await addContacts(inputs);
  return { source: file, backup_path: backup.path, parsed_rows: objects.length, summary };
}

// ── Delete (soft / archive — recoverable; backup written first) ───────────────

export interface DeleteIdentifier { id?: string; linkedin_url?: string; full_name?: string; company?: string; }
export interface DeleteMatch { id: string; full_name: string; company: string | null; linkedin_url: string | null; }
export interface DeleteResult { query: string; action: 'archived' | 'not_found'; matched: DeleteMatch[]; }
export interface DeleteContactsSummary { archived: number; not_found: number; backup_path: string; results: DeleteResult[]; }

/**
 * Soft-delete (archive) 1..N contacts by id, linkedin_url, or full_name + company. Archived
 * rows are excluded from find_warm_intros / find_founders but stay recoverable in the row.
 * Writes a backup first, and echoes exactly which rows matched (name + company + url) so a
 * wrong fuzzy match is catchable.
 */
export async function deleteContacts(ids: DeleteIdentifier[]): Promise<DeleteContactsSummary> {
  const backup = backupContacts('predelete');
  return runInWriteLock(() => {
    const db = getDb();
    const tx = db.transaction(() => {
      const sel = (clause: string) => db.prepare(
        `SELECT lc.id, lc.full_name, c.name AS company, lc.linkedin_url
         FROM linkedin_connections lc LEFT JOIN companies c ON c.id = lc.company_id
         WHERE ${clause} AND lc.archived_at IS NULL`);
      const byId   = sel('lc.id = ?');
      const byUrl  = sel('lc.linkedin_url = ?');
      const byName = sel('LOWER(lc.full_name) = LOWER(?) AND lc.company_id IS ?');
      const archive = db.prepare(`UPDATE linkedin_connections SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);

      const results: DeleteResult[] = [];
      let archived = 0, notFound = 0;
      for (const idf of ids) {
        let rows: DeleteMatch[] = [];
        let query = '(empty identifier)';
        if (idf.id) { query = `id=${idf.id}`; const r = byId.get(idf.id) as DeleteMatch | undefined; if (r) rows = [r]; }
        else if (idf.linkedin_url) { query = idf.linkedin_url; const r = byUrl.get(idf.linkedin_url) as DeleteMatch | undefined; if (r) rows = [r]; }
        else if (idf.full_name) {
          const company_id = idf.company ? (findCompanyByName(idf.company)?.id ?? null) : null;
          query = `${idf.full_name}${idf.company ? ` @ ${idf.company}` : ''}`;
          rows = byName.all(idf.full_name, company_id) as DeleteMatch[];
        }
        if (!rows.length) { notFound++; results.push({ query, action: 'not_found', matched: [] }); continue; }
        for (const r of rows) { archive.run(r.id); archived++; }
        results.push({ query, action: 'archived', matched: rows });
      }
      return { archived, not_found: notFound, backup_path: backup.path, results };
    });
    return tx();
  });
}
