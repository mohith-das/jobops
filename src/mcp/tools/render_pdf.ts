import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { renderPdf, type RenderedFile } from '../../core/render.js';
import { getDb, runInWriteLock } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';

export const renderPdfTool = defineTool({
  name: 'render_pdf',
  title: 'Render resume/cover PDF',
  description:
    'HTML → PDF via Playwright using the career-ops template. Returns a localhost link ' +
    'per file AND writes resume_path / cover_path onto the application row so the ' +
    'tracker, apply_prefill, and daily_digest can find the artifacts. Advances ' +
    'materials_drafted → ready_to_review in the job lifecycle.',
  inputSchema: {
    job_id:      z.string().min(1),
    kind:        z.enum(['resume', 'cover', 'both']).default('resume'),
    cover_body:  z.string().optional().describe('Plain-prose cover letter body (used when kind includes cover). 250-350 words.'),
    page_format: z.enum(['a4', 'letter']).default('letter'),
  },
  handler: async (args) => {
    try {
      const files = await renderPdf(args);
      const persisted = await persistRenderedFiles(args.job_id, files);
      return okResult({
        job_id: args.job_id,
        files: files.map(f => ({ kind: f.kind, url: f.url, bytes: f.bytes, path: f.path })),
        application_id: persisted.application_id,
        application_status: persisted.status,
        status_advanced: persisted.status_advanced,
      });
    } catch (err: any) {
      return errResult(`render_pdf failed: ${err?.message ?? String(err)}`);
    }
  },
});

/**
 * Write the rendered file paths onto the application row for this job.
 *
 *   - If an application row exists, UPDATE its resume_path / cover_path (only the kinds
 *     that were rendered this call — never NULL-out the other kind by accident).
 *   - If no row exists, INSERT a stub (status='ready_to_review', materials_v=1).
 *   - Advance status from 'materials_drafted' → 'ready_to_review'. Don't move it
 *     backwards if it's already past that (applied / screen / onsite / offer / rejected).
 *   - Mirror onto jobs.status for the tracker.
 *
 * Exported so the unit test can hit it without invoking Playwright.
 */
export interface PersistResult {
  application_id: string;
  status:         string;
  status_advanced: boolean;
}

export async function persistRenderedFiles(
  job_id: string,
  files: Pick<RenderedFile, 'kind' | 'path'>[],
): Promise<PersistResult> {
  const resume = files.find(f => f.kind === 'resume')?.path ?? null;
  const cover  = files.find(f => f.kind === 'cover')?.path  ?? null;

  return runInWriteLock(() => {
    const db = getDb();
    const existing = db.prepare(`
      SELECT id, status FROM applications WHERE job_id = ?
    `).get(job_id) as { id: string; status: string } | undefined;

    const PRE_RENDER = new Set(['materials_drafted', 'render_error']);

    if (existing) {
      const advance = PRE_RENDER.has(existing.status);
      db.prepare(`
        UPDATE applications SET
          resume_path = COALESCE(?, resume_path),
          cover_path  = COALESCE(?, cover_path),
          status      = CASE WHEN status IN ('materials_drafted','render_error')
                              THEN 'ready_to_review'
                              ELSE status END,
          last_status_change_at = CASE WHEN status IN ('materials_drafted','render_error')
                                        THEN CURRENT_TIMESTAMP
                                        ELSE last_status_change_at END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(resume, cover, existing.id);
      mirrorJobStatus(db, job_id);
      const after = db.prepare(`SELECT status FROM applications WHERE id = ?`).get(existing.id) as { status: string };
      return {
        application_id: existing.id,
        status:         after.status,
        status_advanced: advance && after.status === 'ready_to_review',
      };
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO applications (id, job_id, status, resume_path, cover_path, materials_v, last_status_change_at)
      VALUES (?, ?, 'ready_to_review', ?, ?, 1, CURRENT_TIMESTAMP)
    `).run(id, job_id, resume, cover);
    mirrorJobStatus(db, job_id);
    return { application_id: id, status: 'ready_to_review', status_advanced: true };
  });
}

// Mirror status onto jobs.status — only advance from earlier states. Don't push a job
// already in applied / screen / onsite / offer / rejected backwards.
function mirrorJobStatus(db: ReturnType<typeof getDb>, job_id: string): void {
  db.prepare(`
    UPDATE jobs SET status = 'ready_to_review', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status IN ('sourced','ready_to_apply','materials_drafted')
  `).run(job_id);
}
