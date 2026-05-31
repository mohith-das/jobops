// G1 — read tools + state transitions on jobs.
//
// All writes serialize through runInWriteLock (db.ts).

import { z } from 'zod';

import { config } from '../../config.js';
import { getDb, runInWriteLock } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';
import { safeJson } from '../../core/llm.js';

// Allowed transitions — denylist of obvious impossibilities; we don't enforce a strict
// state machine because the brief allows manual overrides. The CHECK on jobs.status is
// the hard guard.
const STATUSES = [
  'sourced','ready_to_apply','materials_drafted','ready_to_review',
  'applied','screen','onsite','offer','rejected','discarded','skip',
] as const;

const ROLE_CATEGORIES = ['pm','ml_eng','data_eng','analytics_eng','swe','forward_deployed','other'] as const;

// ── get_top_jobs ─────────────────────────────────────────────────────────────

export const getTopJobsTool = defineTool({
  name: 'get_top_jobs',
  title: 'Top scored jobs (triage)',
  description:
    'Triage view of rated jobs, filterable by min score, role_category, and status. Default min_score=75, limit=20. ' +
    'Use a non-default `role_category` to get a per-role lane (e.g. PM-only).',
  inputSchema: {
    min_score:     z.number().int().min(0).max(100).default(75),
    role_category: z.enum(ROLE_CATEGORIES).optional(),
    status:        z.enum(STATUSES).optional(),
    limit:         z.number().int().min(1).max(200).default(20),
  },
  handler: async (args) => {
    const where = ['j.score_total IS NOT NULL', 'j.score_total >= ?'];
    const params: any[] = [args.min_score];
    if (args.role_category) { where.push('j.role_category = ?'); params.push(args.role_category); }
    if (args.status)        { where.push('j.status = ?');        params.push(args.status); }
    const rows = getDb().prepare(`
      SELECT
        j.id AS job_id,
        j.title,
        COALESCE(c.name, j.company_name_raw) AS company_name,
        j.score_total, j.score_resume_fit, j.score_taste_fit, j.score_visa_fit,
        j.role_category, j.seniority, j.location_raw AS location,
        j.status, j.source_url, j.discovered_at, j.scored_at,
        (SELECT er.html_path FROM eval_reports er WHERE er.job_id = j.id ORDER BY er.created_at DESC LIMIT 1) AS report_html
      FROM jobs j
      LEFT JOIN companies c ON c.id = j.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY j.score_total DESC, datetime(j.discovered_at) DESC
      LIMIT ?
    `).all(...params, args.limit) as any[];

    const items = rows.map(r => {
      const out: any = {
        ...r,
        report_url: r.report_html ? `${config.baseUrl}/files/${r.report_html}` : null,
        report_html: undefined,
      };
      if (!config.visaScoringEnabled) delete out.score_visa_fit;
      return out;
    });
    return okResult({ count: items.length, min_score: args.min_score, items });
  },
});

// ── get_tracker ──────────────────────────────────────────────────────────────

export const getTrackerTool = defineTool({
  name: 'get_tracker',
  title: 'Tracker view (JSON)',
  description: 'Full pipeline snapshot as JSON. Optional `status` filter. Mirrors what the dashboard at / shows.',
  inputSchema: {
    status: z.enum(STATUSES).optional(),
    limit:  z.number().int().min(1).max(500).default(100),
  },
  handler: async (args) => {
    const where: string[] = [];
    const params: any[] = [];
    if (args.status) { where.push('j.status = ?'); params.push(args.status); }
    const sql = `
      SELECT
        j.id AS job_id, j.title,
        COALESCE(c.name, j.company_name_raw) AS company_name,
        j.score_total, j.role_category, j.seniority,
        j.location_raw AS location, j.status, j.source_url,
        j.discovered_at, j.scored_at, j.applied_at,
        (SELECT er.html_path FROM eval_reports er WHERE er.job_id = j.id ORDER BY er.created_at DESC LIMIT 1) AS report_html,
        (SELECT a.resume_path FROM applications a WHERE a.job_id = j.id LIMIT 1) AS resume_path,
        (SELECT a.cover_path  FROM applications a WHERE a.job_id = j.id LIMIT 1) AS cover_path
      FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY datetime(j.discovered_at) DESC LIMIT ?
    `;
    const rows = getDb().prepare(sql).all(...params, args.limit) as any[];
    const counts = getDb().prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`).all() as any[];
    return okResult({
      counts_by_status: Object.fromEntries(counts.map(c => [c.status, c.n])),
      filtered_count:   rows.length,
      tracker_url:      `${config.baseUrl}/`,
      items: rows.map(r => ({
        ...r,
        report_url: r.report_html ? `${config.baseUrl}/files/${r.report_html}` : null,
        resume_url: r.resume_path ? `${config.baseUrl}/files/${r.resume_path}` : null,
        cover_url:  r.cover_path  ? `${config.baseUrl}/files/${r.cover_path}`  : null,
        report_html: undefined, resume_path: undefined, cover_path: undefined,
      })),
    });
  },
});

// ── update_status ────────────────────────────────────────────────────────────

export const updateStatusTool = defineTool({
  name: 'update_status',
  title: 'Update job status',
  description: 'Move a job to a new canonical status. Stamps applied_at when transitioning to "applied".',
  inputSchema: {
    job_id: z.string().min(1),
    status: z.enum(STATUSES),
    note:   z.string().optional(),
  },
  handler: async (args) => {
    const result = await runInWriteLock(() => {
      const db = getDb();
      const existing = db.prepare('SELECT status FROM jobs WHERE id = ?').get(args.job_id) as { status: string } | undefined;
      if (!existing) return { ok: false, message: `no job ${args.job_id}` };
      // applied_at gets stamped only on the applied transition; updated_at always.
      const appliedClause = args.status === 'applied' ? ', applied_at = CURRENT_TIMESTAMP' : '';
      db.prepare(
        `UPDATE jobs SET status = ?, updated_at = CURRENT_TIMESTAMP${appliedClause} WHERE id = ?`,
      ).run(args.status, args.job_id);
      if (args.note) {
        const cur = db.prepare('SELECT score_detail FROM jobs WHERE id = ?').get(args.job_id) as { score_detail: string | null };
        const det = safeJson<any>(cur?.score_detail, {});
        det.status_history = (Array.isArray(det.status_history) ? det.status_history : []);
        det.status_history.push({
          at: new Date().toISOString(), from: existing.status, to: args.status, note: args.note,
        });
        db.prepare('UPDATE jobs SET score_detail = ? WHERE id = ?').run(JSON.stringify(det), args.job_id);
      }
      return { ok: true, from: existing.status, to: args.status };
    });
    if (!result.ok) return errResult(result.message ?? 'failed');
    return okResult({ job_id: args.job_id, from: result.from, to: result.to });
  },
});

// ── mark_ready_to_apply ──────────────────────────────────────────────────────

export const markReadyToApplyTool = defineTool({
  name: 'mark_ready_to_apply',
  title: 'Bulk-mark jobs ready to apply',
  description: 'Bulk-sets job status to ready_to_apply. Skips jobs in terminal states (applied/screen/onsite/offer/rejected/discarded).',
  inputSchema: { job_ids: z.array(z.string().min(1)).min(1).max(200) },
  handler: async (args) => {
    const TERMINAL = new Set(['applied','screen','onsite','offer','rejected','discarded']);
    const summary = await runInWriteLock(() => {
      const db = getDb();
      const tx = db.transaction((ids: string[]) => {
        const out = { updated: [] as string[], skipped: [] as { job_id: string; reason: string }[] };
        const sel = db.prepare('SELECT status FROM jobs WHERE id = ?');
        const upd = db.prepare(`UPDATE jobs SET status = 'ready_to_apply', updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
        for (const id of ids) {
          const row = sel.get(id) as { status: string } | undefined;
          if (!row) { out.skipped.push({ job_id: id, reason: 'not found' }); continue; }
          if (TERMINAL.has(row.status)) {
            out.skipped.push({ job_id: id, reason: `terminal state ${row.status}` }); continue;
          }
          upd.run(id);
          out.updated.push(id);
        }
        return out;
      });
      return tx(args.job_ids);
    });
    return okResult({ updated_count: summary.updated.length, ...summary });
  },
});

