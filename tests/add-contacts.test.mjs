// add_contacts: batch upsert of network contacts from chat → linkedin_connections, with the
// same company alias resolution + title classification as import_linkedin, discoverable by
// find_warm_intros / find_founders.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-add-contacts-'));
  process.env.MCP_JSA_DATA_DIR     = sandbox;
  process.env.MCP_JSA_OUTPUT_DIR   = sandbox + '/output';
  process.env.MCP_JSA_PROJECT_ROOT = sandbox;
  const { getDb } = await import('../dist/db.js');
  getDb();
});
after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

const rowByName = async (name) => {
  const { getDb } = await import('../dist/db.js');
  return getDb().prepare('SELECT * FROM linkedin_connections WHERE full_name = ?').get(name);
};

// ── 1. multi-contact batch insert ───────────────────────────────────────────────

test('inserts a batch of contacts in one call', async () => {
  const { addContacts } = await import('../dist/core/contacts.js');
  const r = await addContacts([
    { full_name: 'Alice Stone',  company: 'Vercel',  position: 'Product Manager', linkedin_url: 'https://linkedin.com/in/alice-stone' },
    { full_name: 'Bob Rivera',   company: 'Vercel',  position: 'Backend Engineer', linkedin_url: 'https://linkedin.com/in/bob-rivera' },
    { full_name: 'Cara Lin',     company: 'Notion',  position: 'Recruiter',         linkedin_url: 'https://linkedin.com/in/cara-lin' },
  ]);
  assert.equal(r.total, 3);
  assert.equal(r.inserted, 3);
  assert.equal(r.updated, 0);
  assert.equal(r.skipped, 0);
  assert.ok(r.results.every(x => x.action === 'inserted'));
});

// ── 2. mixed insert + update in one call ────────────────────────────────────────

test('mixed insert + update: matches existing by linkedin_url', async () => {
  const { addContacts } = await import('../dist/core/contacts.js');
  const r = await addContacts([
    { full_name: 'Alice Stone', company: 'Vercel', position: 'Director of Product', linkedin_url: 'https://linkedin.com/in/alice-stone' }, // exists → update
    { full_name: 'Dan Pope',    company: 'Vercel', position: 'SRE',                  linkedin_url: 'https://linkedin.com/in/dan-pope' },     // new → insert
  ]);
  assert.equal(r.updated, 1);
  assert.equal(r.inserted, 1);
  const alice = await rowByName('Alice Stone');
  assert.equal(alice.position, 'Director of Product', 'updated in place, no duplicate');
  // No duplicate Alice rows.
  const { getDb } = await import('../dist/db.js');
  const count = getDb().prepare('SELECT COUNT(*) n FROM linkedin_connections WHERE full_name = ?').get('Alice Stone').n;
  assert.equal(count, 1);
});

// ── 3. alias resolution → discoverable by find_warm_intros ──────────────────────

test('company alias resolution makes a contact discoverable by find_warm_intros', async () => {
  const { addContacts } = await import('../dist/core/contacts.js');
  const { upsertJob } = await import('../dist/core/jobs.js');
  const { findWarmIntrosTool } = await import('../dist/mcp/tools/outreach.js');
  const { getDb } = await import('../dist/db.js');

  // A scored job at "Anthropic".
  const job = await upsertJob({ source: 'test', source_url: 'test://anthropic/' + Math.random(),
    company_name: 'Anthropic', title: 'Member of Technical Staff' });
  getDb().prepare('UPDATE jobs SET score_total = 90, scored_at = CURRENT_TIMESTAMP WHERE id = ?').run(job.id);

  // A contact at the legal-name variant "ANTHROPIC PBC" — engineer, non-recruiter.
  const r = await addContacts([
    { full_name: 'Erin Walsh', company: 'ANTHROPIC PBC', position: 'Staff Software Engineer',
      linkedin_url: 'https://linkedin.com/in/erin-walsh' },
  ]);
  assert.equal(r.results[0].resolved_company, 'Anthropic', 'resolved to the existing Anthropic row');

  const res = await findWarmIntrosTool.handler({ company: 'anthropic', min_score: 0, limit: 50 });
  const names = res.structuredContent.items.map(i => i.connection_name);
  assert.ok(names.includes('Erin Walsh'), `warm intros should include the contact; got ${JSON.stringify(names)}`);
});

// ── 4. classification inference from title ──────────────────────────────────────

test('infers role flags from the title when not provided', async () => {
  const { addContacts } = await import('../dist/core/contacts.js');
  await addContacts([
    { full_name: 'Rita Talent',  company: 'Acme', position: 'Senior Technical Recruiter', linkedin_url: 'u://rita' },
    { full_name: 'Sam Coder',    company: 'Acme', position: 'Staff Software Engineer',     linkedin_url: 'u://sam' },
    { full_name: 'Val Boss',     company: 'Acme', position: 'VP of Product',               linkedin_url: 'u://val' },
  ]);
  const rita = await rowByName('Rita Talent');
  const sam  = await rowByName('Sam Coder');
  const val  = await rowByName('Val Boss');
  assert.equal(rita.is_recruiter, 1);
  assert.equal(sam.is_engineering, 1);
  assert.equal(val.is_leadership, 1);
  assert.equal(sam.is_recruiter, 0);
});

test('caller-provided flags override title inference', async () => {
  const { addContacts } = await import('../dist/core/contacts.js');
  await addContacts([
    { full_name: 'Override Person', company: 'Acme', position: 'Software Engineer', is_engineering: false, linkedin_url: 'u://override' },
  ]);
  const row = await rowByName('Override Person');
  assert.equal(row.is_engineering, 0, 'explicit false beats the engineer-title inference');
});

// ── 5. one invalid row skipped, valid ones succeed ──────────────────────────────

test('skips an invalid (no full_name) row and reports it, without failing the batch', async () => {
  const { addContacts } = await import('../dist/core/contacts.js');
  const r = await addContacts([
    { company: 'Acme', position: 'Engineer', linkedin_url: 'u://nameless' },     // invalid: no full_name
    { full_name: 'Gina Ok',  company: 'Acme', linkedin_url: 'u://gina' },
    { full_name: 'Hank Fine', company: 'Acme', linkedin_url: 'u://hank' },
  ]);
  assert.equal(r.skipped, 1);
  assert.equal(r.inserted, 2);
  const skipped = r.results.find(x => x.action === 'skipped');
  assert.ok(skipped && /full_name/.test(skipped.reason));
  assert.ok(await rowByName('Gina Ok'));
  assert.ok(await rowByName('Hank Fine'));
});

// ── 6. merge, don't clobber, on update ──────────────────────────────────────────

test('update merges — omitted fields are preserved (COALESCE)', async () => {
  const { addContacts } = await import('../dist/core/contacts.js');
  await addContacts([
    { full_name: 'Mona Keep', company: 'Acme', position: 'PM', linkedin_url: 'u://mona',
      email: 'mona@example.com', notes: 'met at a conference' },
  ]);
  // Update with ONLY a new title — email + notes must survive.
  await addContacts([{ full_name: 'Mona Keep', linkedin_url: 'u://mona', position: 'Group PM' }]);
  const row = await rowByName('Mona Keep');
  assert.equal(row.position, 'Group PM', 'title updated');
  assert.equal(row.email, 'mona@example.com', 'email preserved');
  assert.equal(row.notes, 'met at a conference', 'notes preserved');
});

// ── 7. partial contact: per-contact unresolved reporting ────────────────────────

test('partial contact (full_name only) is stored and gaps are reported', async () => {
  const { addContacts } = await import('../dist/core/contacts.js');
  const r = await addContacts([{ full_name: 'Solo Person' }]);
  assert.equal(r.inserted, 1);
  const u = r.results[0].unresolved;
  assert.ok(u.includes('no company'));
  assert.ok(u.includes('no linkedin_url'));
  assert.ok(u.includes('no email'));
  assert.ok(await rowByName('Solo Person'), 'partial contact still persisted');
});

// ── 8. tool handler: title alias + skip reporting end-to-end ────────────────────

test('add_contacts tool: accepts `title` alias and reports skips', async () => {
  const { addContactsTool } = await import('../dist/mcp/tools/add_contacts.js');
  const res = await addContactsTool.handler({ contacts: [
    { title: 'Founder & CEO', full_name: 'Tia Lead', company: 'Acme', linkedin_url: 'u://tia' },
    { company: 'Acme' },  // skipped (no full_name)
  ] });
  const out = res.structuredContent;
  assert.equal(out.inserted, 1);
  assert.equal(out.skipped, 1);
  const tia = await rowByName('Tia Lead');
  assert.equal(tia.position, 'Founder & CEO', 'title mapped to position');
  assert.equal(tia.is_leadership, 1, 'inferred leadership from title');
});
