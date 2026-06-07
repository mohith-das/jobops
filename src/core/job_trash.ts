// Shared job status + trash/restore/purge logic, used by BOTH the chat tools (tracker.ts,
// job_trash tools) and the HTTP tracker UI endpoints (http/app.ts) — one implementation, no
// duplication.
//
// Philosophy (matches contacts + career-packet work): soft-delete is the default destructive
// action (recoverable, hidden from default views, queryable via listTrashedJobs); hard removal
// is ONLY via purge — explicit, and a timestamped backup of the affected rows is written to the
// project root first. Every op echoes exactly which jobs (title + company) it touched.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../config.js';
import { getDb, runInWriteLock } from '../db.js';
import { safeJson } from './llm.js';

export const JOB_STATUSES = [
  'sourced', 'ready_to_apply', 'materials_drafted', 'ready_to_review',
  'applied', 'screen', 'onsite', 'offer', 'rejected', 'discarded', 'skip',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobEcho {
  job_id: string;
  title: string;
  company: string;
  status: string;          // the job's lifecycle status (its "prior state" while trashed)
  trashed_at?: string | null;
}

const DISPLAY_SELECT = `
  SELECT j.id AS job_id, j.title, COALESCE(c.name, j.company_name_raw) AS company,
         j.status, j.trashed_at
  FROM jobs j LEFT JOIN companies c ON c.id = j.company_id`;

function tsStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function backupJobRows(rows: unknown[], reason: string): string {
  const path = resolve(config.projectRoot, `jobs_backup_${reason}_${tsStamp()}.json`);
  writeFileSync(path, JSON.stringify(rows, null, 2), 'utf-8');
  return path;
}

// ── Status (shared by update_status tool + UI status dropdown) ────────────────

export async function setJobStatus(jobId: string, status: JobStatus, note?: string):
  Promise<{ ok: true; from: string; to: string } | { ok: false; message: string }> {
  return runInWriteLock(() => {
    const db = getDb();
    const existing = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string } | undefined;
    if (!existing) return { ok: false as const, message: `no job ${jobId}` };
    const appliedClause = status === 'applied' ? ', applied_at = CURRENT_TIMESTAMP' : '';
    db.prepare(`UPDATE jobs SET status = ?, updated_at = CURRENT_TIMESTAMP${appliedClause} WHERE id = ?`).run(status, jobId);
    if (note) {
      const cur = db.prepare('SELECT score_detail FROM jobs WHERE id = ?').get(jobId) as { score_detail: string | null };
      const det = safeJson<any>(cur?.score_detail, {});
      det.status_history = Array.isArray(det.status_history) ? det.status_history : [];
      det.status_history.push({ at: new Date().toISOString(), from: existing.status, to: status, note });
      db.prepare('UPDATE jobs SET score_detail = ? WHERE id = ?').run(JSON.stringify(det), jobId);
    }
    return { ok: true as const, from: existing.status, to: status };
  });
}

// ── Soft-delete (trash) / restore ─────────────────────────────────────────────

export interface TrashResult { job_id: string; title?: string; company?: string; status?: string; action: 'trashed' | 'already_trashed' | 'not_found'; }
export interface TrashSummary { trashed: number; results: TrashResult[] }

/** Soft-delete jobs by id and/or by status filter. Recoverable; status left untouched. */
export async function trashJobs(opts: { jobIds?: string[]; statuses?: string[] }): Promise<TrashSummary> {
  return runInWriteLock(() => {
    const db = getDb();
    const tx = db.transaction(() => {
      const ids = new Set<string>(opts.jobIds ?? []);
      if (opts.statuses?.length) {
        const ph = opts.statuses.map(() => '?').join(',');
        for (const r of db.prepare(`SELECT id FROM jobs WHERE status IN (${ph}) AND trashed_at IS NULL`).all(...opts.statuses) as { id: string }[]) {
          ids.add(r.id);
        }
      }
      const getRow = db.prepare(`${DISPLAY_SELECT} WHERE j.id = ?`);
      const trash  = db.prepare(`UPDATE jobs SET trashed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
      const results: TrashResult[] = [];
      let trashed = 0;
      for (const id of ids) {
        const row = getRow.get(id) as JobEcho | undefined;
        if (!row) { results.push({ job_id: id, action: 'not_found' }); continue; }
        if (row.trashed_at) { results.push({ job_id: id, title: row.title, company: row.company, status: row.status, action: 'already_trashed' }); continue; }
        trash.run(id); trashed++;
        results.push({ job_id: id, title: row.title, company: row.company, status: row.status, action: 'trashed' });
      }
      return { trashed, results };
    });
    return tx();
  });
}

export interface RestoreResult { job_id: string; title?: string; company?: string; status?: string; action: 'restored' | 'not_trashed' | 'not_found'; }

export async function restoreJobs(jobIds: string[]): Promise<{ restored: number; results: RestoreResult[] }> {
  return runInWriteLock(() => {
    const db = getDb();
    const tx = db.transaction(() => {
      const getRow  = db.prepare(`${DISPLAY_SELECT} WHERE j.id = ?`);
      const restore = db.prepare(`UPDATE jobs SET trashed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
      const results: RestoreResult[] = [];
      let restored = 0;
      for (const id of jobIds) {
        const row = getRow.get(id) as JobEcho | undefined;
        if (!row) { results.push({ job_id: id, action: 'not_found' }); continue; }
        if (!row.trashed_at) { results.push({ job_id: id, title: row.title, company: row.company, status: row.status, action: 'not_trashed' }); continue; }
        restore.run(id); restored++;
        results.push({ job_id: id, title: row.title, company: row.company, status: row.status, action: 'restored' });
      }
      return { restored, results };
    });
    return tx();
  });
}

/** Currently-trashed jobs, newest-trashed first. Shown by list_trashed + the /trash page. */
export function listTrashedJobs(): Array<JobEcho & { score_total: number | null; location: string | null }> {
  return getDb().prepare(`
    SELECT j.id AS job_id, j.title, COALESCE(c.name, j.company_name_raw) AS company,
           j.status, j.trashed_at, j.score_total, j.location_raw AS location
    FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
    WHERE j.trashed_at IS NOT NULL
    ORDER BY datetime(j.trashed_at) DESC
  `).all() as any[];
}

// ── Hard delete (purge) — explicit + backup-first ─────────────────────────────

export interface PurgeSummary { purged: number; backup_path: string | null; results: Array<{ job_id: string; title?: string; company?: string; action: 'purged' | 'not_trashed' | 'not_found' }>; }

/**
 * Permanently delete TRASHED jobs (only trashed — a job must be soft-deleted first). Writes a
 * timestamped backup of the affected full rows before deleting. FK dependents cascade / null
 * per the schema. `all: true` purges everything currently in trash.
 */
export async function purgeJobs(opts: { jobIds?: string[]; all?: boolean }): Promise<PurgeSummary> {
  return runInWriteLock(() => {
    const db = getDb();
    const tx = db.transaction(() => {
      // Determine the target trashed rows.
      let targets: { id: string }[];
      if (opts.all) {
        targets = db.prepare(`SELECT id FROM jobs WHERE trashed_at IS NOT NULL`).all() as { id: string }[];
      } else {
        targets = [];
        const isTrashed = db.prepare(`SELECT id FROM jobs WHERE id = ? AND trashed_at IS NOT NULL`);
        for (const id of opts.jobIds ?? []) {
          if (isTrashed.get(id)) targets.push({ id });
        }
      }
      const results: PurgeSummary['results'] = [];
      // Echo + not-trashed/not-found accounting for explicitly-listed ids.
      if (!opts.all) {
        const getRow = db.prepare(`${DISPLAY_SELECT} WHERE j.id = ?`);
        const targetSet = new Set(targets.map(t => t.id));
        for (const id of opts.jobIds ?? []) {
          const row = getRow.get(id) as JobEcho | undefined;
          if (!row) results.push({ job_id: id, action: 'not_found' });
          else if (!targetSet.has(id)) results.push({ job_id: id, title: row.title, company: row.company, action: 'not_trashed' });
        }
      }
      if (!targets.length) return { purged: 0, backup_path: null, results };

      // Backup the FULL rows (+ display name) before the irreversible delete.
      const ph = targets.map(() => '?').join(',');
      const ids = targets.map(t => t.id);
      const fullRows = db.prepare(`
        SELECT j.*, COALESCE(c.name, j.company_name_raw) AS company_display
        FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.id IN (${ph})
      `).all(...ids) as any[];
      const backup_path = backupJobRows(fullRows, opts.all ? 'purgeall' : 'purge');

      const del = db.prepare(`DELETE FROM jobs WHERE id = ? AND trashed_at IS NOT NULL`);
      let purged = 0;
      for (const r of fullRows) {
        del.run(r.id); purged++;
        results.push({ job_id: r.id, title: r.title, company: r.company_display, action: 'purged' });
      }
      return { purged, backup_path, results };
    });
    return tx();
  });
}
