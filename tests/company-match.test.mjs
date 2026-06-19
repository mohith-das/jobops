// Feature 3: company-name fuzzy matching.
//   Part A — pure canonicalization (suffix-stripping, case, punctuation).
//   Part B — DB round-trip: legal-name variants resolve to ONE company row, and
//            findCompanyByName resolves a legal-name query to the same row.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeCompanyName, canonicalCompanyName } from '../dist/core/company_match.js';

// ── Part A: pure canonicalization ──────────────────────────────────────────────

test('canonical strips common legal suffixes', () => {
  assert.equal(canonicalCompanyName('ANTHROPIC PBC'),     'anthropic');
  assert.equal(canonicalCompanyName('Google LLC'),        'google');
  assert.equal(canonicalCompanyName('Stripe, Inc.'),      'stripe');
  assert.equal(canonicalCompanyName('OpenAI Inc'),        'openai');
  assert.equal(canonicalCompanyName('Acme Corporation'),  'acme');
  assert.equal(canonicalCompanyName('Foo Corp'),          'foo');
  assert.equal(canonicalCompanyName('Bar Co'),            'bar');
  assert.equal(canonicalCompanyName('Spotify AB'),        'spotify');
  assert.equal(canonicalCompanyName('SAP GmbH'),          'sap');
  assert.equal(canonicalCompanyName('Revolut Ltd'),       'revolut');
});

test('canonical is case-insensitive and whitespace/punctuation tolerant', () => {
  assert.equal(canonicalCompanyName('anthropic'),    canonicalCompanyName('ANTHROPIC PBC'));
  assert.equal(canonicalCompanyName('  Google   LLC  '), 'google');
  assert.equal(canonicalCompanyName('Google,LLC'),   'google');
  assert.equal(canonicalCompanyName('The Foo Company'), 'foo');
});

test('canonical strips chained/dotted suffixes', () => {
  assert.equal(canonicalCompanyName('Foo Co., Ltd.'),  'foo');
  assert.equal(canonicalCompanyName('Bar Pvt Ltd'),    'bar');
  assert.equal(canonicalCompanyName('Baz L.L.C.'),     'baz');
});

test('canonical never nukes the only token (company literally named a suffix word)', () => {
  assert.equal(canonicalCompanyName('Co'),   'co');
  assert.equal(canonicalCompanyName('Inc'),  'inc');
});

test('canonical keeps multi-word names that merely contain a suffix word mid-string', () => {
  // "Co" only stripped when trailing — "Co-op Labs" should not lose its leading token.
  assert.equal(canonicalCompanyName('Cohere'),         'cohere');
  assert.equal(canonicalCompanyName('Incident.io'),    'incident io');
});

test('canonical handles empty / garbage input', () => {
  assert.equal(canonicalCompanyName(''),        '');
  assert.equal(canonicalCompanyName(null),      '');
  assert.equal(canonicalCompanyName(undefined), '');
  assert.equal(canonicalCompanyName('   '),     '');
});

test('normalize is the light touch (keeps suffixes, lowercases, collapses ws)', () => {
  assert.equal(normalizeCompanyName('ANTHROPIC PBC'), 'anthropic pbc');
  assert.equal(normalizeCompanyName('  Google   LLC '), 'google llc');
});

// ── Part B: DB round-trip ──────────────────────────────────────────────────────

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-company-match-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = sandbox + '/output';
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test('legal-name variants collapse onto one company row (clean name first)', async () => {
  const { upsertCompany } = await import('../dist/core/jobs.js');
  const a = upsertCompany('Anthropic', { source: 'jd' });
  const b = upsertCompany('ANTHROPIC PBC', { source: 'h1b' });
  const c = upsertCompany('Anthropic, Inc.', { source: 'linkedin' });
  assert.equal(a, b, 'ANTHROPIC PBC should resolve to the same row as Anthropic');
  assert.equal(a, c, 'Anthropic, Inc. should resolve to the same row as Anthropic');
});

test('legal-name variants collapse regardless of insertion order (suffix first)', async () => {
  const { upsertCompany } = await import('../dist/core/jobs.js');
  const a = upsertCompany('Google LLC', { source: 'h1b' });
  const b = upsertCompany('Google', { source: 'jd' });
  assert.equal(a, b, 'Google should resolve to the same row as Google LLC');
});

test('findCompanyByName resolves a legal-name query to the canonical row', async () => {
  const { upsertCompany, findCompanyByName } = await import('../dist/core/jobs.js');
  const id = upsertCompany('Stripe', { source: 'jd' });
  const hit = findCompanyByName('Stripe, Inc.');
  assert.ok(hit, 'expected a match for "Stripe, Inc."');
  assert.equal(hit.id, id);
});

test('distinct companies stay distinct', async () => {
  const { upsertCompany } = await import('../dist/core/jobs.js');
  const figma = upsertCompany('Figma', { source: 'jd' });
  const notion = upsertCompany('Notion Labs, Inc.', { source: 'jd' });
  assert.notEqual(figma, notion);
});

test('resolved variants are recorded in company_aliases', async () => {
  const { upsertCompany } = await import('../dist/core/jobs.js');
  const { getDb } = await import('../dist/db.js');
  const id = upsertCompany('Vercel Inc', { source: 'h1b' });
  upsertCompany('Vercel', { source: 'linkedin' });
  const aliases = getDb()
    .prepare('SELECT alias_normalized, source FROM company_aliases WHERE company_id = ?')
    .all(id);
  // canonical key must be present, and the h1b variant ("vercel inc") recorded.
  assert.ok(aliases.some(a => a.alias_normalized === 'vercel' && a.source === 'canonical'),
    `expected canonical alias, got ${JSON.stringify(aliases)}`);
  assert.ok(aliases.some(a => a.alias_normalized === 'vercel inc'),
    `expected the variant recorded, got ${JSON.stringify(aliases)}`);
});
