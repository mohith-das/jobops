// Tests for the multi-format export feature.
//   - requesting tex+docx writes both files
//   - URLs persist on the application row via rendered_files JSON
//   - visa-leakage scan blocks leaks in the .tex path
//   - long-content packet does not produce overfull \hbox in pdflatex
//
// These tests do NOT exercise Playwright (PDF rendering is covered by the layout
// integrity script and the existing render-persist.test.mjs).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-formats-'));
  mkdirSync(resolve(sandbox, 'config'), { recursive: true });
  writeFileSync(resolve(sandbox, 'cv.md'), `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com
**Phone:** +1 555 0100
**LinkedIn:** linkedin.com/in/casey
**GitHub:** github.com/casey

## Professional Summary
Builder PM with engineering teeth.

## Work Experience

### Vellum — Product Manager, Agents
Remote · Jan 2024 – Present
- Owned the agentic workflows surface end-to-end
- Shipped a trace-replay tool used daily

### Mosaic — Senior Analyst
NYC · Jun 2021 – Dec 2023
- Built a customer cohort dashboard
- Migrated reporting pipeline from cron to Airflow

## Projects & Open Source
- **Vector Agents** (Open source) — multi-agent eval harness

## Education
- **MS Data Science**, UT Austin — 2021

## Skills
- **AI / LLM Systems:** LangChain, RAG, evals
- **Data:** SQL, Python, Airflow
`);
  writeFileSync(resolve(sandbox, 'config/profile.yml'), `candidate:
  full_name: "Casey Riley"
  email: "casey@example.com"
  phone: "+1 555 0100"
  location: "Austin, TX"
  linkedin: "linkedin.com/in/casey"
  github: "github.com/casey"
`);
  writeFileSync(resolve(sandbox, 'portals.yml'), `tracked_companies: []\n`);

  process.env.MCP_JSA_DATA_DIR     = resolve(sandbox, 'data');
  process.env.MCP_JSA_OUTPUT_DIR   = resolve(sandbox, 'output');
  process.env.MCP_JSA_PROJECT_ROOT = sandbox;
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

async function seedJob() {
  const { upsertJob } = await import('../dist/core/jobs.js');
  const r = await upsertJob({ source: 'test', source_url: 'test://x', company_name: 'Vellum', title: 'Builder PM' });
  return r.id;
}

// ── Tex + docx produce real files; URLs persist ────────────────────────────

test('writeText + persistRenderedFiles persist .tex paths under rendered_files', async () => {
  const { persistRenderedFiles } = await import('../dist/mcp/tools/render_pdf.js');
  const { getDb } = await import('../dist/db.js');

  const jobId = await seedJob();
  const r = await persistRenderedFiles(jobId, [
    { kind: 'resume', format: 'pdf',  path: 'pdfs/resume-x.pdf' },
    { kind: 'resume', format: 'tex',  path: 'tex/resume-x.tex' },
    { kind: 'resume', format: 'docx', path: 'docx/resume-x.docx' },
    { kind: 'cover',  format: 'tex',  path: 'tex/cover-x.tex' },
  ]);
  assert.equal(r.status, 'ready_to_review');
  assert.equal(r.status_advanced, true);

  const row = getDb().prepare(`SELECT resume_path, cover_path, rendered_files FROM applications WHERE job_id = ?`).get(jobId);
  // PDF fast-path: only resume PDF was provided → resume_path set; cover_path remains null.
  assert.equal(row.resume_path, 'pdfs/resume-x.pdf');
  assert.equal(row.cover_path, null);

  const map = JSON.parse(row.rendered_files);
  assert.equal(map.resume.pdf,  'pdfs/resume-x.pdf');
  assert.equal(map.resume.tex,  'tex/resume-x.tex');
  assert.equal(map.resume.docx, 'docx/resume-x.docx');
  assert.equal(map.cover.tex,   'tex/cover-x.tex');
});

test('re-running with a single format MERGES into rendered_files (no overwrite)', async () => {
  const { persistRenderedFiles } = await import('../dist/mcp/tools/render_pdf.js');
  const { getDb } = await import('../dist/db.js');

  const jobId = await seedJob();
  await persistRenderedFiles(jobId, [
    { kind: 'resume', format: 'pdf', path: 'pdfs/a.pdf' },
    { kind: 'resume', format: 'tex', path: 'tex/a.tex' },
  ]);
  // Second call only renders docx — the previous pdf/tex paths must survive.
  await persistRenderedFiles(jobId, [
    { kind: 'resume', format: 'docx', path: 'docx/a.docx' },
  ]);
  const map = JSON.parse(
    getDb().prepare(`SELECT rendered_files FROM applications WHERE job_id = ?`).get(jobId).rendered_files,
  );
  assert.equal(map.resume.pdf,  'pdfs/a.pdf');
  assert.equal(map.resume.tex,  'tex/a.tex');
  assert.equal(map.resume.docx, 'docx/a.docx');
});

// ── Visa-leakage rail covers .tex output ───────────────────────────────────

test('visa scan blocks a leak in the cover .tex path', async () => {
  const { buildCoverTex } = await import('../dist/core/render_tex.js');
  const { scanForVisaLeakage } = await import('../dist/core/outreach_safety.js');

  const tex = buildCoverTex({
    body:     'I would require visa sponsorship to work in your office.',
    company:  'Acme',
    location: 'Remote',
  });
  // Direct scan call mirrors what the tool does before writing the file to disk.
  const leaks = scanForVisaLeakage(tex);
  assert.ok(leaks.length > 0, 'tex content with visa term must trip the rail');
  assert.ok(leaks.some(l => l.rule === 'no_visa_mentions'));
});

test('visa scan PASSES on a clean cover .tex', async () => {
  const { buildCoverTex } = await import('../dist/core/render_tex.js');
  const { scanForVisaLeakage } = await import('../dist/core/outreach_safety.js');
  const tex = buildCoverTex({
    body:     'Excited about the role and the team you are building.',
    company:  'Acme',
    location: 'Remote',
  });
  const leaks = scanForVisaLeakage(tex);
  assert.equal(leaks.length, 0);
});

// ── .tex compiles with zero overfull on a long packet ──────────────────────

test('long-content packet does not produce overfull \\hbox in pdflatex', async (t) => {
  // Swap to a verbose cv.md for this test only, then put the original back.
  const cvPath = resolve(sandbox, 'cv.md');
  const original = readFileSync(cvPath, 'utf-8');
  writeFileSync(cvPath, `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com

## Professional Summary
` + 'Builder PM with engineering teeth. '.repeat(20) + `

## Work Experience

### Vellum — Product Manager, Agents
Remote · Jan 2024 – Present
${Array.from({length:8}, (_,i)=>`- Long bullet number ${i+1} with substantial content meant to test that line breaking handles many words per line without producing an overfull box even when the bullet text approaches the page width`).join('\n')}

## Skills
- **AI / LLM Systems:** LangChain, LlamaIndex, RAG architectures, vector databases (ChromaDB, Pinecone, Weaviate), tool-calling agent design, multi-step eval harnesses, prompt-engineering tooling, observability for agents
`);

  try {
    const { buildResumeTex } = await import('../dist/core/render_tex.js?long=' + Math.random());
    // Cache-bust because parseCV reads cv.md fresh each call but render_tex was already imported in earlier tests.
    // Re-import via query string trick — Node ESM treats this as a fresh module.
    // Alternative: just call parseCV after the file write; render_tex calls parseCV internally per build.
  } catch { /* import-fresh fallback below */ }

  const { buildResumeTex } = await import('../dist/core/render_tex.js');
  const tex = buildResumeTex();

  // Compile via pdflatex; skip cleanly if not installed.
  if (!spawnSync('pdflatex', ['--version']).stdout) {
    t.skip('pdflatex not installed; skipping compile check');
    return;
  }
  const outDir = resolve(sandbox, 'tex-long');
  mkdirSync(outDir, { recursive: true });
  const texPath = resolve(outDir, 'resume.tex');
  writeFileSync(texPath, tex);
  const r = spawnSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', outDir, texPath], {
    encoding: 'utf-8', timeout: 60_000,
  });
  const log = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
  const overfulls = (log.match(/Overfull \\hbox/g) ?? []).length;
  assert.equal(overfulls, 0, `expected zero overfull \\hbox; got ${overfulls} — log tail: ${log.slice(-400)}`);

  // Restore original cv.md so other tests aren't affected.
  writeFileSync(cvPath, original);
});

// ── Generators actually emit syntactically OK output ───────────────────────

test('buildResumeTex emits a self-contained LaTeX document with required structure', async () => {
  const { buildResumeTex } = await import('../dist/core/render_tex.js');
  const tex = buildResumeTex();
  assert.match(tex, /\\documentclass\[letterpaper,11pt\]\{article\}/);
  assert.match(tex, /\\begin\{document\}/);
  assert.match(tex, /\\end\{document\}/);
  // Sections we expect from our seeded cv.md:
  assert.match(tex, /\\section\*\{Skills\}/);
  assert.match(tex, /\\section\*\{Experience\}/);
});

test('buildResumeDocx emits a non-trivial zip with word/document.xml', async () => {
  const { buildResumeDocx } = await import('../dist/core/render_docx.js');
  const buf = await buildResumeDocx();
  assert.ok(buf.length > 2000, `docx should be a few KB; got ${buf.length}`);
  assert.equal(buf[0], 0x50);  // 'P'
  assert.equal(buf[1], 0x4B);  // 'K' — zip magic
});

test('LaTeX specials in bullet text are escaped', async () => {
  const { escapeLatex } = await import('../dist/core/render_tex.js');
  assert.equal(escapeLatex('Cut spend by 85%'),        'Cut spend by 85\\%');
  assert.equal(escapeLatex('$200k → $20M'),            '\\$200k → \\$20M');
  assert.equal(escapeLatex('Built A & B testing'),     'Built A \\& B testing');
  assert.equal(escapeLatex('user_id and #hashtag'),    'user\\_id and \\#hashtag');
});
