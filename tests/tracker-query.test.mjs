// Tracker filter + search + sort + server-side pagination — the shared query that powers
// both the dashboard UI and the get_tracker MCP tool.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-tracker-query-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = sandbox + '/output';
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  const { getDb } = await import('../dist/db.js');
  getDb();

  // Seed a known dataset: 40 jobs across companies/statuses/scores.
  const { upsertJob } = await import('../dist/core/jobs.js');
  const db = getDb();
  for (let i = 0; i < 40; i++) {
    const company = i % 2 === 0 ? 'Acme' : 'Globex';
    const title = i % 3 === 0 ? `Senior Engineer ${i}` : `Product Manager ${i}`;
    const r = await upsertJob({ source: 'test', source_url: `test://job/${i}`, company_name: company, title });
    const score = 50 + (i % 50);             // 50..99
    const status = i < 10 ? 'applied' : 'sourced';
    db.prepare('UPDATE jobs SET score_total = ?, status = ?, role_category = ? WHERE id = ?')
      .run(score, status, i % 3 === 0 ? 'swe' : 'pm', r.id);
  }
  // One trashed job (should never appear by default).
  const t = await upsertJob({ source: 'test', source_url: 'test://trashed', company_name: 'Acme', title: 'Trashed Engineer' });
  db.prepare('UPDATE jobs SET score_total = 95, status = ?, trashed_at = CURRENT_TIMESTAMP WHERE id = ?').run('applied', t.id);
});
after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

// ── pagination ────────────────────────────────────────────────────────────────

test('pagination returns correct page slices + accurate total (excludes trashed)', async () => {
  const { queryTracker } = await import('../dist/core/tracker_query.js');
  const p1 = queryTracker({ limit: 25, offset: 0 });
  const p2 = queryTracker({ limit: 25, offset: 25 });
  assert.equal(p1.total, 40, 'total is the full active set (trashed excluded)');
  assert.equal(p1.items.length, 25);
  assert.equal(p2.items.length, 15, 'last page has the remainder');
  // No overlap between pages.
  const ids1 = new Set(p1.items.map(i => i.job_id));
  assert.ok(p2.items.every(i => !ids1.has(i.job_id)), 'pages do not overlap');
  // Trashed job is absent.
  assert.ok([...p1.items, ...p2.items].every(i => i.title !== 'Trashed Engineer'));
});

test('default sort is score desc', async () => {
  const { queryTracker } = await import('../dist/core/tracker_query.js');
  const r = queryTracker({ limit: 50 });
  const scores = r.items.map(i => i.score_total);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i], 'descending by score');
});

// ── filters ─────────────────────────────────────────────────────────────────--

test('status filter narrows correctly', async () => {
  const { queryTracker } = await import('../dist/core/tracker_query.js');
  const r = queryTracker({ statuses: ['applied'], limit: 100 });
  assert.equal(r.total, 10);
  assert.ok(r.items.every(i => i.status === 'applied'));
});

test('min/max score filter narrows correctly', async () => {
  const { queryTracker } = await import('../dist/core/tracker_query.js');
  const r = queryTracker({ min_score: 70, limit: 100 });
  assert.ok(r.items.every(i => i.score_total >= 70));
  const r2 = queryTracker({ min_score: 60, max_score: 70, limit: 100 });
  assert.ok(r2.items.every(i => i.score_total >= 60 && i.score_total <= 70));
});

test('company filter (contains, case-insensitive)', async () => {
  const { queryTracker } = await import('../dist/core/tracker_query.js');
  const r = queryTracker({ company: 'glob', limit: 100 });
  assert.ok(r.total > 0);
  assert.ok(r.items.every(i => /globex/i.test(i.company_name)));
});

test('role_category filter', async () => {
  const { queryTracker } = await import('../dist/core/tracker_query.js');
  const r = queryTracker({ role_category: 'swe', limit: 100 });
  assert.ok(r.total > 0);
  assert.ok(r.items.every(i => i.role_category === 'swe'));
});

// ── search ────────────────────────────────────────────────────────────────────

test('title search is case-insensitive substring', async () => {
  const { queryTracker } = await import('../dist/core/tracker_query.js');
  const r = queryTracker({ q: 'product manager', limit: 100 });
  assert.ok(r.total > 0);
  assert.ok(r.items.every(i => /product manager/i.test(i.title)));
});

// ── compose: filters + search + pagination ───────────────────────────────────

test('combined filters + search + page compose', async () => {
  const { queryTracker } = await import('../dist/core/tracker_query.js');
  const full = queryTracker({ statuses: ['sourced'], min_score: 60, q: 'engineer', limit: 1000 });
  assert.ok(full.items.every(i => i.status === 'sourced' && i.score_total >= 60 && /engineer/i.test(i.title)));
  // Page 2 of the same filter is a non-overlapping slice with the same total.
  const pg1 = queryTracker({ statuses: ['sourced'], min_score: 60, q: 'engineer', limit: 3, offset: 0 });
  const pg2 = queryTracker({ statuses: ['sourced'], min_score: 60, q: 'engineer', limit: 3, offset: 3 });
  assert.equal(pg1.total, full.total);
  assert.equal(pg2.total, full.total);
  const ids = new Set(pg1.items.map(i => i.job_id));
  assert.ok(pg2.items.every(i => !ids.has(i.job_id)));
});

test('show_trashed includes trashed rows when asked', async () => {
  const { queryTracker } = await import('../dist/core/tracker_query.js');
  const without = queryTracker({ q: 'trashed engineer', limit: 100 });
  assert.equal(without.total, 0, 'trashed excluded by default');
  const withT = queryTracker({ q: 'trashed engineer', show_trashed: true, limit: 100 });
  assert.equal(withT.total, 1);
  assert.equal(withT.items[0].trashed, true);
});

// ── count cards stay full-pipeline regardless of filter ───────────────────────

test('pipelineCounts is the full active pipeline, independent of any filter', async () => {
  const { pipelineCounts } = await import('../dist/core/tracker_query.js');
  const c = pipelineCounts();
  assert.equal(c.applied, 10);
  assert.equal(c.sourced, 30);
  assert.equal(c.total, 40, 'trashed excluded from totals');
});

// ── get_tracker MCP tool honors the new params ────────────────────────────────

test('get_tracker tool honors statuses + min_score + pagination, keeps full counts', async () => {
  const { getTrackerTool } = await import('../dist/mcp/tools/tracker.js');
  const res = await getTrackerTool.handler({ statuses: ['applied'], min_score: 70, limit: 5, offset: 0 });
  const out = res.structuredContent;
  assert.ok(out.items.every(i => i.status === 'applied' && i.score_total >= 70));
  assert.ok(out.items.length <= 5);
  assert.equal(typeof out.total_matching, 'number');
  assert.equal(out.filtered_count, out.items.length);
  // counts_by_status is the FULL pipeline (not the filtered slice).
  assert.equal(out.counts_by_status.applied, 10);
  assert.equal(out.counts_by_status.sourced, 30);
});

test('get_tracker excludes trashed by default but includes with show_trashed', async () => {
  const { getTrackerTool } = await import('../dist/mcp/tools/tracker.js');
  const def = await getTrackerTool.handler({ q: 'trashed engineer' });
  assert.equal(def.structuredContent.total_matching, 0);
  const shown = await getTrackerTool.handler({ q: 'trashed engineer', show_trashed: true });
  assert.equal(shown.structuredContent.total_matching, 1);
});
