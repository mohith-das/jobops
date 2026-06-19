// Job soft-delete (trash) + restore + hard purge, via chat tools, core, and the shared HTTP
// UI endpoints (proving chat + UI operate on the same logic).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-job-trash-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = sandbox + '/output';
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  const { getDb } = await import('../dist/db.js');
  getDb();
});
after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

async function seedJob(company, title, { score, status } = {}) {
  const { upsertJob } = await import('../dist/core/jobs.js');
  const { getDb } = await import('../dist/db.js');
  const r = await upsertJob({ source: 'test', source_url: 'test://' + Math.random(), company_name: company, title });
  if (score != null) getDb().prepare('UPDATE jobs SET score_total = ?, scored_at = CURRENT_TIMESTAMP WHERE id = ?').run(score, r.id);
  if (status) getDb().prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, r.id);
  return r.id;
}
const trackerHas = async (id) => {
  const { getTrackerTool } = await import('../dist/mcp/tools/tracker.js');
  const res = await getTrackerTool.handler({ limit: 500 });
  return res.structuredContent.items.some(i => i.job_id === id);
};

// ── delete_jobs → drops from views → list_trashed → restore ──────────────────

test('delete_jobs trashes by id; job drops from tracker + top_jobs; list_trashed shows it; restore brings it back', async () => {
  const { deleteJobsTool, restoreJobsTool, listTrashedTool } = await import('../dist/mcp/tools/job_trash.js');
  const { getTopJobsTool } = await import('../dist/mcp/tools/tracker.js');
  const id = await seedJob('TrashCo', 'Backend Engineer', { score: 90 });

  assert.equal(await trackerHas(id), true, 'present before trashing');

  const del = await deleteJobsTool.handler({ job_ids: [id] });
  assert.equal(del.structuredContent.trashed, 1);
  assert.equal(del.structuredContent.results[0].title, 'Backend Engineer');
  assert.equal(del.structuredContent.results[0].company, 'TrashCo');

  assert.equal(await trackerHas(id), false, 'gone from tracker default view');
  const top = await getTopJobsTool.handler({ min_score: 0, limit: 200 });
  assert.ok(!top.structuredContent.items.some(i => i.job_id === id), 'gone from get_top_jobs');

  const trashed = await listTrashedTool.handler({});
  assert.ok(trashed.structuredContent.items.some(i => i.job_id === id), 'shows in list_trashed');

  const rest = await restoreJobsTool.handler({ job_ids: [id] });
  assert.equal(rest.structuredContent.restored, 1);
  assert.equal(await trackerHas(id), true, 'back in tracker after restore');
});

test('delete_jobs by status filter trashes all matching jobs', async () => {
  const { deleteJobsTool, listTrashedTool } = await import('../dist/mcp/tools/job_trash.js');
  const a = await seedJob('SkipCo', 'Role A', { status: 'skip' });
  const b = await seedJob('SkipCo', 'Role B', { status: 'skip' });
  const keep = await seedJob('KeepCo', 'Role C', { status: 'sourced' });

  const del = await deleteJobsTool.handler({ statuses: ['skip'] });
  assert.ok(del.structuredContent.trashed >= 2);
  const trashedIds = (await listTrashedTool.handler({})).structuredContent.items.map(i => i.job_id);
  assert.ok(trashedIds.includes(a) && trashedIds.includes(b));
  assert.ok(!trashedIds.includes(keep), 'sourced job not trashed');
});

// ── purge: only trashed, backup-first, confirm for purge_all ─────────────────

test('purge_jobs hard-deletes only trashed jobs and writes a backup; not-trashed is reported', async () => {
  const { deleteJobsTool, purgeJobsTool } = await import('../dist/mcp/tools/job_trash.js');
  const { getJob } = await import('../dist/core/jobs.js');
  const trashed = await seedJob('PurgeCo', 'To Purge');
  const live    = await seedJob('PurgeCo', 'Stays Live');
  await deleteJobsTool.handler({ job_ids: [trashed] });

  const r = await purgeJobsTool.handler({ job_ids: [trashed, live] });
  assert.equal(r.structuredContent.purged, 1, 'only the trashed one is purged');
  assert.ok(existsSync(r.structuredContent.backup_path), 'backup written before purge');
  assert.equal(getJob(trashed), null, 'trashed job hard-deleted from DB');
  assert.ok(getJob(live), 'live job untouched');
  assert.ok(r.structuredContent.results.some(x => x.job_id === live && x.action === 'not_trashed'));
});

test('purge_all requires confirm; with confirm it empties the trash and backs up', async () => {
  const { deleteJobsTool, purgeJobsTool, listTrashedTool } = await import('../dist/mcp/tools/job_trash.js');
  await deleteJobsTool.handler({ job_ids: [await seedJob('EmptyCo', 'X'), await seedJob('EmptyCo', 'Y')] });
  assert.ok((await listTrashedTool.handler({})).structuredContent.count >= 2);

  const noConfirm = await purgeJobsTool.handler({ purge_all: true });
  assert.equal(noConfirm.isError, true, 'purge_all refused without confirm');
  assert.match(noConfirm.content[0].text, /confirm/i);
  assert.ok((await listTrashedTool.handler({})).structuredContent.count >= 2, 'nothing deleted yet');

  const purged = await purgeJobsTool.handler({ purge_all: true, confirm: true });
  assert.ok(purged.structuredContent.purged >= 2);
  assert.ok(existsSync(purged.structuredContent.backup_path));
  assert.equal((await listTrashedTool.handler({})).structuredContent.count, 0, 'trash is empty');
});

// ── shared logic: HTTP UI endpoints ↔ chat core operate on the same data ─────

test('UI endpoints and chat core share logic (trash via HTTP shows in core list + /trash page)', async () => {
  const { buildHttpApp } = await import('../dist/http/app.js');
  const { listTrashedJobs } = await import('../dist/core/job_trash.js');
  const id = await seedJob('SharedCo', 'Shared Role', { score: 88 });

  const app = buildHttpApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Trash via the HTTP endpoint the UI uses.
    const tr = await fetch(`${base}/api/jobs/${id}/trash`, { method: 'POST' });
    assert.equal(tr.status, 200);
    // Chat core sees it (same DB / same logic).
    assert.ok(listTrashedJobs().some(j => j.job_id === id), 'chat core list_trashed shows the UI-trashed job');
    // The /trash page renders it.
    const page = await (await fetch(`${base}/trash`)).text();
    assert.match(page, /Shared Role/);
    assert.match(page, /SharedCo/);
    // counts endpoint excludes trashed (this job was sourced).
    const counts = await (await fetch(`${base}/api/counts`)).json();
    assert.equal(typeof counts.sourced, 'number');
    // Restore via HTTP, then it's no longer trashed.
    const rs = await fetch(`${base}/api/jobs/${id}/restore`, { method: 'POST' });
    assert.equal(rs.status, 200);
    assert.ok(!listTrashedJobs().some(j => j.job_id === id), 'restored via UI → no longer trashed');
  } finally {
    server.close();
  }
});

test('purge-all HTTP endpoint requires confirm', async () => {
  const { buildHttpApp } = await import('../dist/http/app.js');
  const app = buildHttpApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const noConfirm = await fetch(`${base}/api/trash/purge-all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noConfirm.status, 400);
    const ok = await fetch(`${base}/api/trash/purge-all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});
