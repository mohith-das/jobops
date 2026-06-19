// Contacts export / import (non-destructive merge) + soft-delete with backups.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-contacts-io-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = sandbox + '/output';
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  const { getDb } = await import('../dist/db.js');
  getDb();
});
after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

const rowByName = async (name) => {
  const { getDb } = await import('../dist/db.js');
  return getDb().prepare('SELECT * FROM linkedin_connections WHERE full_name = ?').get(name);
};
const countByName = async (name) => {
  const { getDb } = await import('../dist/db.js');
  return getDb().prepare('SELECT COUNT(*) n FROM linkedin_connections WHERE full_name = ?').get(name).n;
};

// ── non-destructive round-trip ───────────────────────────────────────────────

test('export → chat edit → re-import OLD export: the chat-only field survives, no duplicate', async () => {
  const { addContacts, exportContacts, importContacts } = await import('../dist/core/contacts.js');

  // Seed a contact with NO notes.
  await addContacts([{ full_name: 'Round Trip', company: 'Acme', position: 'Engineer', linkedin_url: 'u://rt' }]);

  // Export now (notes is blank in this file).
  const exp = exportContacts();
  assert.ok(existsSync(exp.csv_path) && existsSync(exp.json_path));

  // A chat-only edit AFTER the export: add notes.
  await addContacts([{ full_name: 'Round Trip', linkedin_url: 'u://rt', notes: 'met at a conference' }]);
  assert.equal((await rowByName('Round Trip')).notes, 'met at a conference');

  // Re-import the OLD export (which has notes blank). Merge must NOT wipe the newer notes.
  const imp = await importContacts(exp.json_path);
  assert.equal(imp.summary.inserted, 0, 're-import creates no new rows');
  assert.equal(await countByName('Round Trip'), 1, 'no duplicate');
  assert.equal((await rowByName('Round Trip')).notes, 'met at a conference', 'chat-only field preserved (merge, not replace)');
  assert.ok(existsSync(imp.backup_path), 'a backup was written before import');
});

test('idempotent round-trip: re-importing a full export creates zero duplicates', async () => {
  const { addContacts, exportContacts, importContacts } = await import('../dist/core/contacts.js');
  const { getDb } = await import('../dist/db.js');
  await addContacts([
    { full_name: 'Ida North', company: 'Beta', linkedin_url: 'u://ida' },
    { full_name: 'Jon West',  company: 'Beta', linkedin_url: 'u://jon' },
  ]);
  const before = getDb().prepare('SELECT COUNT(*) n FROM linkedin_connections').get().n;
  const exp = exportContacts();
  const imp = await importContacts(exp.json_path);
  const after = getDb().prepare('SELECT COUNT(*) n FROM linkedin_connections').get().n;
  assert.equal(imp.summary.inserted, 0);
  assert.equal(after, before, 'row count unchanged after re-importing the export');
});

// ── soft delete: right rows, not-found, recoverable, backup ──────────────────

test('delete_contacts archives the right rows, reports not-found, writes a backup, and hides from find_warm_intros', async () => {
  const { addContacts, deleteContacts } = await import('../dist/core/contacts.js');
  const { upsertJob } = await import('../dist/core/jobs.js');
  const { findWarmIntrosTool } = await import('../dist/mcp/tools/outreach.js');
  const { getDb } = await import('../dist/db.js');

  // A scored job at Delco + an engineer contact there → discoverable as a warm intro.
  const job = await upsertJob({ source: 'test', source_url: 'test://delco/' + Math.random(), company_name: 'Delco', title: 'Engineer' });
  getDb().prepare('UPDATE jobs SET score_total = 90, scored_at = CURRENT_TIMESTAMP WHERE id = ?').run(job.id);
  await addContacts([{ full_name: 'Del Me', company: 'Delco', position: 'Staff Engineer', linkedin_url: 'u://del' }]);

  const pre = await findWarmIntrosTool.handler({ company: 'delco', min_score: 0, limit: 50 });
  assert.ok(pre.structuredContent.items.some(i => i.connection_name === 'Del Me'), 'discoverable before delete');

  const r = await deleteContacts([
    { linkedin_url: 'u://del' },
    { full_name: 'Ghost Person', company: 'Nowhere' },   // not found
  ]);
  assert.equal(r.archived, 1);
  assert.equal(r.not_found, 1);
  assert.ok(existsSync(r.backup_path), 'backup written before delete');
  const archivedResult = r.results.find(x => x.action === 'archived');
  assert.equal(archivedResult.matched[0].full_name, 'Del Me', 'echoes exactly which row was removed');
  assert.ok(r.results.some(x => x.action === 'not_found'));

  // Hidden from discovery…
  const post = await findWarmIntrosTool.handler({ company: 'delco', min_score: 0, limit: 50 });
  assert.ok(!post.structuredContent.items.some(i => i.connection_name === 'Del Me'), 'hidden after soft-delete');
  // …but the row still exists (recoverable), just archived.
  const row = await rowByName('Del Me');
  assert.ok(row, 'row still present (soft delete, not hard delete)');
  assert.ok(row.archived_at, 'archived_at is set');
});

test('delete tool reports not-found cleanly for an unknown contact', async () => {
  const { deleteContactsTool } = await import('../dist/mcp/tools/contacts_io.js');
  const res = await deleteContactsTool.handler({ contacts: [{ linkedin_url: 'u://does-not-exist' }] });
  assert.equal(res.structuredContent.archived, 0);
  assert.equal(res.structuredContent.not_found, 1);
});
