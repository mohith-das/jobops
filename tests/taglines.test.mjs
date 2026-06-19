// Feature 2: per-archetype taglines.
//   Part A — pure normalizeTaglines (map shape, list shape, absent = back-compat).
//   Part B — reseed auto-fills career_packet Section 2 from config/profile.yml.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// NB: profile.js loads the config singleton on import (freezing projectRoot). We must set
// JOBOPS_PROJECT_ROOT in before() BEFORE the first import, so every import here is dynamic.

// ── Part A: normalizeTaglines ──────────────────────────────────────────────────

test('normalizeTaglines: map shape preserves order, drops empties', async () => {
  const { normalizeTaglines } = await import('../dist/core/profile.js');
  const out = normalizeTaglines({
    'Builder PM': 'ships product with engineering teeth',
    'Applied AI Engineer': 'turns prototypes into shipped systems',
    'Empty One': '',
  });
  assert.deepEqual(out, [
    { archetype: 'Builder PM', tagline: 'ships product with engineering teeth' },
    { archetype: 'Applied AI Engineer', tagline: 'turns prototypes into shipped systems' },
  ]);
});

test('normalizeTaglines: list shape (archetype/name + tagline)', async () => {
  const { normalizeTaglines } = await import('../dist/core/profile.js');
  const out = normalizeTaglines([
    { archetype: 'Forward-Deployed', tagline: 'embeds with customers' },
    { name: 'Builder PM', tagline: 'PRD to prod' },
    { name: 'No tagline' },
  ]);
  assert.deepEqual(out, [
    { archetype: 'Forward-Deployed', tagline: 'embeds with customers' },
    { archetype: 'Builder PM', tagline: 'PRD to prod' },
  ]);
});

test('normalizeTaglines: absent/garbage → [] (back-compat signal)', async () => {
  const { normalizeTaglines } = await import('../dist/core/profile.js');
  assert.deepEqual(normalizeTaglines(undefined), []);
  assert.deepEqual(normalizeTaglines(null), []);
  assert.deepEqual(normalizeTaglines({}), []);
  assert.deepEqual(normalizeTaglines([]), []);
});

// ── Part B: reseed round-trip ──────────────────────────────────────────────────

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-taglines-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = sandbox + '/output';
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function writeProfile(yml) {
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  writeFileSync(join(sandbox, 'config', 'profile.yml'), yml, 'utf-8');
}

test('reseed auto-fills Section 2 from profile.yml taglines', async () => {
  writeProfile(`
candidate:
  full_name: "Test User"
  email: "test@example.com"
taglines:
  "Builder PM": "ships product with engineering teeth"
  "Applied AI Engineer": "turns LLM prototypes into shipped systems"
  "Forward-Deployed": "embeds with customers and closes the deal"
`);
  const { seedCareerPacketFromFiles, getActiveCareerPacket } = await import('../dist/core/profile.js');
  await seedCareerPacketFromFiles({ mode: 'reseed' });
  const active = getActiveCareerPacket();
  assert.ok(active, 'expected an active packet');
  const body = active.content;

  // Section 2 should now contain the real taglines, not the <…> placeholders.
  assert.match(body, /\*\*Builder PM\*\* — "ships product with engineering teeth"/);
  assert.match(body, /\*\*Applied AI Engineer\*\* — "turns LLM prototypes into shipped systems"/);
  assert.match(body, /\*\*Forward-Deployed\*\* — "embeds with customers and closes the deal"/);
  // The "B. ML / Applied AI Engineer" style template placeholder should be gone.
  assert.doesNotMatch(body, /one-line positioning that works across all your target roles/);
});

test('reseed leaves Section 2 template intact when taglines absent (back-compat)', async () => {
  writeProfile(`
candidate:
  full_name: "Test User"
  email: "test@example.com"
`);
  const { seedCareerPacketFromFiles, getActiveCareerPacket } = await import('../dist/core/profile.js');
  await seedCareerPacketFromFiles({ mode: 'reseed' });
  const body = getActiveCareerPacket().content;
  // The original template placeholder text must still be present.
  assert.match(body, /one-line positioning that works across all your target roles/);
});
