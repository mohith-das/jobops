// Regression for bug 3: render_pdf must write resume_path + cover_path onto the
// applications row so get_tracker / apply_prefill see the artifacts. Tests the
// persistRenderedFiles() helper directly with fake file paths — no Playwright /
// Chromium required.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-render-persist-'));
  // Point the server's data/output/project root at the sandbox BEFORE any module loads
  // config.ts (it's imported lazily by the modules under test).
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = sandbox + '/output';
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  // Trigger schema creation
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

async function seedJob(title = 'Test Role', company = 'TestCo') {
  const { upsertJob } = await import('../dist/core/jobs.js');
  const r = await upsertJob({
    source:     'test',
    source_url: 'test://' + Math.random(),
    company_name: company,
    title,
  });
  return r.id;
}

test('creates an application row with paths when none exists; advances status', async () => {
  const { persistRenderedFiles } = await import('../dist/mcp/tools/render_pdf.js');
  const { getDb } = await import('../dist/db.js');

  const jobId = await seedJob('Builder PM', 'Vercel');
  const result = await persistRenderedFiles(jobId, [
    { kind: 'resume', format: 'pdf', path: 'pdfs/resume-builder-pm-abcd1234.pdf' },
    { kind: 'cover',  format: 'pdf', path: 'pdfs/cover-builder-pm-abcd1234.pdf'  },
  ]);

  assert.equal(result.status, 'ready_to_review');
  assert.equal(result.status_advanced, true);
  assert.ok(result.application_id);

  const row = getDb().prepare(`
    SELECT resume_path, cover_path, status FROM applications WHERE job_id = ?
  `).get(jobId);
  assert.equal(row.resume_path, 'pdfs/resume-builder-pm-abcd1234.pdf');
  assert.equal(row.cover_path,  'pdfs/cover-builder-pm-abcd1234.pdf');
  assert.equal(row.status,      'ready_to_review');

  const job = getDb().prepare(`SELECT status FROM jobs WHERE id = ?`).get(jobId);
  assert.equal(job.status, 'ready_to_review', 'jobs.status should mirror to ready_to_review');
});

test('updates existing application row; advances status from materials_drafted', async () => {
  const { persistRenderedFiles } = await import('../dist/mcp/tools/render_pdf.js');
  const { getDb } = await import('../dist/db.js');
  const { randomUUID } = await import('node:crypto');

  const jobId = await seedJob('AI PM', 'Notion');
  const appId = randomUUID();
  getDb().prepare(`
    INSERT INTO applications (id, job_id, status, materials_v)
    VALUES (?, ?, 'materials_drafted', 1)
  `).run(appId, jobId);

  const r = await persistRenderedFiles(jobId, [
    { kind: 'resume', format: 'pdf', path: 'pdfs/r.pdf' },
    { kind: 'cover',  format: 'pdf', path: 'pdfs/c.pdf'  },
  ]);
  assert.equal(r.application_id, appId, 'must reuse existing application row');
  assert.equal(r.status, 'ready_to_review');
  assert.equal(r.status_advanced, true);
});

test('does NOT move terminal-state jobs backwards', async () => {
  const { persistRenderedFiles } = await import('../dist/mcp/tools/render_pdf.js');
  const { getDb } = await import('../dist/db.js');
  const { randomUUID } = await import('node:crypto');

  const jobId = await seedJob('Senior PM', 'Mosaic');
  getDb().prepare(`UPDATE jobs SET status = 'applied' WHERE id = ?`).run(jobId);
  const appId = randomUUID();
  getDb().prepare(`
    INSERT INTO applications (id, job_id, status, materials_v)
    VALUES (?, ?, 'applied', 1)
  `).run(appId, jobId);

  const r = await persistRenderedFiles(jobId, [
    { kind: 'resume', format: 'pdf', path: 'pdfs/re-render.pdf' },
  ]);
  assert.equal(r.status, 'applied',         'must NOT move applied → ready_to_review');
  assert.equal(r.status_advanced, false);

  const job = getDb().prepare(`SELECT status FROM jobs WHERE id = ?`).get(jobId);
  assert.equal(job.status, 'applied', 'jobs.status must not be pushed backwards either');

  const row = getDb().prepare(`SELECT resume_path FROM applications WHERE id = ?`).get(appId);
  assert.equal(row.resume_path, 'pdfs/re-render.pdf', 'path must still update');
});

test('rendering only cover does not NULL-out an existing resume_path', async () => {
  const { persistRenderedFiles } = await import('../dist/mcp/tools/render_pdf.js');
  const { getDb } = await import('../dist/db.js');

  const jobId = await seedJob('Solutions Engineer', 'Loop');
  await persistRenderedFiles(jobId, [
    { kind: 'resume', format: 'pdf', path: 'pdfs/first-resume.pdf' },
  ]);
  await persistRenderedFiles(jobId, [
    { kind: 'cover', format: 'pdf', path: 'pdfs/cover-only.pdf' },
  ]);
  const row = getDb().prepare(`SELECT resume_path, cover_path FROM applications WHERE job_id = ?`).get(jobId);
  assert.equal(row.resume_path, 'pdfs/first-resume.pdf', 'must preserve previous resume_path');
  assert.equal(row.cover_path,  'pdfs/cover-only.pdf');
});
