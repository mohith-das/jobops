// Feature 1: scaffold modes into project root on init + loader precedence.
//   Part A — loader precedence: <projectRoot>/modes/<file> wins over the bundled default.
//   Part B — `init` scaffolds modes/*.md and a re-init never clobbers an edited copy.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const CLI = resolve(REPO_ROOT, 'dist', 'cli.js');

// ── Part A: loader precedence (in-process) ─────────────────────────────────────

let loaderSandbox;
before(async () => {
  loaderSandbox = mkdtempSync(join(tmpdir(), 'jobops-modes-loader-'));
  // Write a user-edited rubric BEFORE config.ts is first imported so userModesDir resolves here.
  mkdirSync(join(loaderSandbox, 'modes'), { recursive: true });
  writeFileSync(join(loaderSandbox, 'modes', 'rubric.md'), '# USER-EDITED RUBRIC\nfizzbuzz marker\n', 'utf-8');
  process.env.JOBOPS_DATA_DIR     = loaderSandbox;
  process.env.JOBOPS_OUTPUT_DIR   = loaderSandbox + '/output';
  process.env.JOBOPS_PROJECT_ROOT = loaderSandbox;
});

after(() => {
  if (loaderSandbox) rmSync(loaderSandbox, { recursive: true, force: true });
});

test('getMode prefers the user-edited project-root copy over the bundled default', async () => {
  const { getMode, modeSource } = await import('../dist/core/modes.js');
  assert.match(getMode('rubric.md'), /USER-EDITED RUBRIC/);
  assert.equal(modeSource('rubric.md'), 'user');
});

test('getMode falls back to the bundled default for un-overridden files', async () => {
  const { getMode, modeSource } = await import('../dist/core/modes.js');
  // tailoring_rules.md is NOT in the user sandbox → bundled.
  assert.equal(modeSource('tailoring_rules.md'), 'bundled');
  assert.ok(getMode('tailoring_rules.md').length > 100);
  assert.doesNotMatch(getMode('tailoring_rules.md'), /fizzbuzz marker/);
});

// ── Part B: `init` scaffolding (subprocess) ────────────────────────────────────

const MODE_FILES = [
  'tailoring_rules.md', 'rubric.md', 'report_format.md',
  'outreach_tone.md', 'negotiation_playbook.md', 'career_packet.md',
];

function runInit(cwd) {
  return spawnSync(process.execPath, [CLI, 'init'], {
    cwd,
    env: { ...process.env, JOBOPS_PROJECT_ROOT: cwd, JOBOPS_DATA_DIR: join(cwd, 'data') },
    encoding: 'utf-8',
  });
}

test('init scaffolds all mode files into <projectRoot>/modes/', () => {
  const sb = mkdtempSync(join(tmpdir(), 'jobops-init-'));
  try {
    const r = runInit(sb);
    assert.equal(r.status, 0, `init failed: ${r.stderr || r.stdout}`);
    for (const f of MODE_FILES) {
      assert.ok(existsSync(join(sb, 'modes', f)), `expected modes/${f} to be scaffolded`);
    }
    assert.match(r.stdout, /scaffolded modes\/rubric\.md/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('re-init does NOT overwrite an edited mode file (idempotent, warns instead)', () => {
  const sb = mkdtempSync(join(tmpdir(), 'jobops-init2-'));
  try {
    assert.equal(runInit(sb).status, 0);
    // Edit the scaffolded rubric, then re-init.
    const rubricPath = join(sb, 'modes', 'rubric.md');
    const edited = '# MY EDITED RUBRIC\nsentinel-do-not-clobber\n';
    writeFileSync(rubricPath, edited, 'utf-8');
    const r2 = runInit(sb);
    assert.equal(r2.status, 0, `re-init failed: ${r2.stderr || r2.stdout}`);
    assert.equal(readFileSync(rubricPath, 'utf-8'), edited, 'edited rubric must be preserved');
    assert.match(r2.stdout, /modes\/rubric\.md already exists/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});
