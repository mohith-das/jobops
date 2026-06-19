#!/usr/bin/env node
// End-to-end check for JOBOPS_PUBLIC_BASE_URL.
//
// Boots the server three times and verifies the URLs every link-emitting surface
// returns:
//
//   1. UNSET   — every artifact link uses the local listen URL (127.0.0.1).
//   2. SET     — every artifact link uses the configured public base URL; ZERO
//                links contain 127.0.0.1.
//   3. MALFORMED — server prints a warning but boots; links fall back to 127.0.0.1.
//
// For each scenario we hit: get_report, get_tracker, evaluate_job step-2
// (returns report_url + tracker_url), render_pdf with formats=[pdf,tex,docx] (per-
// file URLs), apply_prefill (resume_url + cover_url + screenshot_url), and the
// /healthz endpoint. Every link is asserted to start with the expected base.
//
// `doctor` is also invoked in both UNSET and SET states and the output checked
// for the right effective-base message.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');

const SBOX = process.env.E2E_SBOX ?? resolve(tmpdir(), 'jobops-pbu-' + randomUUID().slice(0, 6));
mkdirSync(SBOX,                              { recursive: true });
mkdirSync(resolve(SBOX, 'config'),           { recursive: true });

writeFileSync(resolve(SBOX, 'cv.md'), `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com

## Work Experience
### Vellum — PM
Remote · 2024 – Present
- Shipped agentic workflows
- Built trace replay

## Skills
- **AI:** LangChain, RAG
`);
writeFileSync(resolve(SBOX, 'config/profile.yml'), `candidate:
  full_name: "Casey Riley"
  email: "casey@example.com"
`);
writeFileSync(resolve(SBOX, 'portals.yml'), `tracked_companies: []\n`);

console.log(`Sandbox: ${SBOX}`);

const failures = [];
const note = (status, name, detail = '') => {
  const tag = status === 'PASS' ? '\x1b[32mPASS\x1b[0m'
           : status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m'
           : '\x1b[33mWARN\x1b[0m';
  console.log(`  ${tag}  ${name}${detail ? '  —  ' + detail : ''}`);
  if (status === 'FAIL') failures.push({ name, detail });
};

// ── Scenario runner ────────────────────────────────────────────────────────

async function bootServer(env, port) {
  const child = spawn('node', [resolve(REPO, 'dist/cli.js'), 'start'], {
    env: {
      ...process.env,
      JOBOPS_PORT:         String(port),
      JOBOPS_PROJECT_ROOT: SBOX,
      JOBOPS_DATA_DIR:     resolve(SBOX, 'data-' + port),
      JOBOPS_OUTPUT_DIR:   resolve(SBOX, 'output-' + port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const banner = [];
  child.stderr.on('data', b => banner.push(b.toString()));
  // Wait for healthz to respond
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return { child, banner };
}

function killServer(child) {
  return new Promise(resolve => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
  });
}

async function rpc(port, method, params = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method:  'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 100000, method, params }),
  });
  const j = await r.json();
  return j?.result?.structuredContent ?? j?.result ?? j;
}

async function callTool(port, name, args) {
  return rpc(port, 'tools/call', { name, arguments: args });
}

// Build a small report + render PDFs in the running sandbox; return every artifact URL.
async function gatherLinks(port) {
  await rpc(port, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' },
  });

  // healthz
  const healthz = await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json());

  // evaluate_job step 1
  const step1 = await callTool(port, 'evaluate_job', {
    input: 'Builder PM at SampleAI. Remote US.',
    mode: 'chat', title: 'Builder PM', company: 'SampleAI',
  });
  const jobId = step1.job_id;

  // evaluate_job step 2 — returns report_url + tracker_url
  const step2 = await callTool(port, 'evaluate_job', {
    job_id: jobId, mode: 'chat',
    report: {
      archetype_detected: 'X',
      block_role_summary: 'tiny', block_cv_match: 'tiny', block_level: 'tiny',
      block_comp: 'tiny', block_personalize: 'tiny', block_interview: 'tiny',
      block_legitimacy: 'tiny', keywords: ['x'],
    },
    scores: { resume_fit: 80, taste_fit: 80, visa_fit: 80, score_total: 80,
              reasoning: 'r', role_category: 'pm', seniority: 'senior' },
  });

  // get_report
  const gr = await callTool(port, 'get_report', { job_id: jobId });

  // render_pdf — all three formats for both kinds
  const rp = await callTool(port, 'render_pdf', {
    job_id: jobId, kind: 'both', formats: ['pdf', 'tex', 'docx'],
    cover_body: 'Reaching out about the role. Excited about your work.',
  });

  // apply_prefill — uses an unrelated URL (about:blank-ish via httpbin would
  // require network; instead point at the tracker which always serves).
  const ap = await callTool(port, 'apply_prefill', {
    job_id: jobId, url: `http://127.0.0.1:${port}/`,
  });

  // get_tracker
  const gt = await callTool(port, 'get_tracker', { limit: 5 });

  return { healthz, step2, gr, rp, ap, gt };
}

async function runScenario(label, envVar, port, expectedBase, options = {}) {
  console.log(`\n=== ${label}  (port ${port}${envVar ? `, env=${envVar}` : ', env=UNSET'}) ===`);
  const env = envVar ? { JOBOPS_PUBLIC_BASE_URL: envVar } : {};
  const { child, banner } = await bootServer(env, port);

  try {
    if (options.malformed) {
      // Boot succeeded ⇒ malformed value did not crash. Check warning landed on stderr.
      const text = banner.join('');
      note(/JOBOPS_PUBLIC_BASE_URL/.test(text) && /WARN/.test(text)
            ? 'PASS' : 'FAIL',
           `${label}: server boots + warns about malformed value`,
           text.includes('WARN') ? '' : text.slice(-200));
    }

    const links = await gatherLinks(port);

    // /healthz reports the effective public base URL.
    note(links.healthz.publicBaseUrl === expectedBase ? 'PASS' : 'FAIL',
         `${label}: /healthz publicBaseUrl`,
         `expected=${expectedBase} got=${links.healthz.publicBaseUrl}`);

    // Every URL emitted by every tool must start with expectedBase.
    const urls = [
      ['step2.report_url',  links.step2.report_url],
      ['step2.tracker_url', links.step2.tracker_url],
      ['get_report.url',    links.gr.url],
      ...links.rp.files.map(f => [`render_pdf.${f.kind}.${f.format}.url`, f.url]),
      ['apply_prefill.resume_url',     links.ap.resume_url],
      ['apply_prefill.cover_url',      links.ap.cover_url],
      ['apply_prefill.screenshot_url', links.ap.screenshot_url],
      ['get_tracker.tracker_url',      links.gt.tracker_url],
      ...links.gt.items.flatMap(it => [
        [`get_tracker.items[].report_url`, it.report_url],
        [`get_tracker.items[].resume_url`, it.resume_url],
        [`get_tracker.items[].cover_url`,  it.cover_url],
      ]),
    ].filter(([_, u]) => typeof u === 'string' && u.length);

    let wrong = 0;
    for (const [name, url] of urls) {
      if (!url.startsWith(expectedBase)) {
        note('FAIL', `${label}: ${name}`, `expected to start with ${expectedBase}; got ${url}`);
        wrong++;
      }
    }
    note(wrong === 0 ? 'PASS' : 'FAIL', `${label}: all ${urls.length} links use ${expectedBase}`,
         wrong ? `${wrong} mismatched` : '');

    // When JOBOPS_PUBLIC_BASE_URL is set to a non-localhost value, ZERO links
    // should still contain 127.0.0.1 anywhere in the string.
    if (options.requireNoLocalhost) {
      const stragglers = urls.filter(([_, u]) => u.includes('127.0.0.1'));
      note(stragglers.length === 0 ? 'PASS' : 'FAIL',
           `${label}: zero links contain 127.0.0.1`,
           stragglers.length ? stragglers.map(([n, u]) => `${n}=${u}`).join(' | ') : '');
    }
  } finally {
    await killServer(child);
  }
}

// ── doctor ─────────────────────────────────────────────────────────────────

function runDoctor(envVar) {
  const env = envVar
    ? { ...process.env, JOBOPS_PUBLIC_BASE_URL: envVar, JOBOPS_PROJECT_ROOT: SBOX }
    : { ...process.env, JOBOPS_PROJECT_ROOT: SBOX };
  delete env.JOBOPS_PUBLIC_BASE_URL;
  if (envVar) env.JOBOPS_PUBLIC_BASE_URL = envVar;
  const r = spawnSync('node', [resolve(REPO, 'dist/cli.js'), 'doctor'], { env, encoding: 'utf-8' });
  return (r.stdout ?? '') + '\n' + (r.stderr ?? '');
}

async function checkDoctor() {
  console.log('\n=== doctor — unset ===');
  const unset = runDoctor(null);
  note(/public base URL:.*default/.test(unset)
    ? 'PASS' : 'FAIL',
    'doctor unset reports default',
    unset.match(/public base URL:.*$/m)?.[0] ?? unset.slice(-200));

  console.log('\n=== doctor — set ===');
  const set = runDoctor('http://test-host:9999');
  note(/public base URL:.*test-host:9999/.test(set) && /JOBOPS_PUBLIC_BASE_URL/.test(set)
    ? 'PASS' : 'FAIL',
    'doctor set reports configured value',
    set.match(/public base URL:.*$/m)?.[0] ?? set.slice(-200));

  console.log('\n=== doctor — malformed ===');
  const bad = runDoctor('not-a-url');
  note(/WARN.*JOBOPS_PUBLIC_BASE_URL/.test(bad) && !/Error|Exception|stack/.test(bad)
    ? 'PASS' : 'FAIL',
    'doctor malformed warns but does not crash',
    bad.match(/WARN.*$/m)?.[0] ?? bad.slice(-200));
}

// ── Main ───────────────────────────────────────────────────────────────────

await runScenario('UNSET',     null,                       9101, 'http://127.0.0.1:9101');
await runScenario('SET',       'http://test-host:9999',    9102, 'http://test-host:9999',
                  { requireNoLocalhost: true });
await runScenario('MALFORMED', 'not-a-url',                9103, 'http://127.0.0.1:9103',
                  { malformed: true });
await checkDoctor();

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`\x1b[32mAll E2E checks PASS.\x1b[0m`);
  console.log(`Sandbox: ${SBOX}`);
  process.exit(0);
} else {
  console.log(`\x1b[31m${failures.length} FAILURE(S):\x1b[0m`);
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  console.log(`Sandbox: ${SBOX}`);
  process.exit(1);
}
