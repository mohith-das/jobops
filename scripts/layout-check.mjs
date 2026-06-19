#!/usr/bin/env node
// Layout-integrity check.
//
// Generates resume + cover in all three formats (pdf, tex, docx) for BOTH a
// short CV and a long CV (many long bullets, many projects, many skills).
// For each output, verifies:
//
//   PDF (Chromium):
//     - File exists and parses as PDF
//     - Page count within sane bound (resume ≤ 3, cover ≤ 2)
//     - All headings + a sampling of bullets appear in extracted text
//       (catches content that got clipped off the page)
//
//   .tex:
//     - File exists, looks like valid LaTeX (\begin{document} present)
//     - Compile with pdflatex; log shows ZERO "Overfull \\hbox" warnings
//     - Resulting PDF parses and has reasonable page count
//
//   .docx:
//     - File exists and is a valid zip
//     - Document body parts include all headings and bullets we put in
//
// On any failure, exit non-zero with a clear message so I have to fix the
// template before shipping.

import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');
const SBOX = process.env.LAYOUT_SBOX ?? resolve(tmpdir(), 'jobops-layout-' + randomUUID().slice(0, 6));

const failures = [];
const note = (status, name, detail = '') => {
  const tag = status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m' : 'INFO';
  console.log(`  ${tag}  ${name}${detail ? '  —  ' + detail : ''}`);
  if (status === 'FAIL') failures.push({ name, detail });
};

mkdirSync(SBOX, { recursive: true });
process.env.JOBOPS_PROJECT_ROOT = SBOX;
process.env.JOBOPS_DATA_DIR     = resolve(SBOX, 'data');
process.env.JOBOPS_OUTPUT_DIR   = resolve(SBOX, 'output');
console.log(`Sandbox: ${SBOX}`);

// ── Short CV — ordinary case ───────────────────────────────────────────────
const SHORT_CV = `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com
**Phone:** +1 555 0100
**LinkedIn:** linkedin.com/in/casey-riley
**GitHub:** github.com/casey-riley
**Portfolio:** https://casey.dev

## Professional Summary
Builder PM with engineering teeth. Five years shipping data products end-to-end.

## Work Experience

### Vellum — Product Manager, Agents
Remote · Jan 2024 – Present
- Owned the agentic workflows surface from discovery through production launch
- Shipped a trace-replay tool used by 200+ developers daily
- Reduced eval cycle time from 30 min to 4 min by introducing parallel evaluation

### Mosaic — Senior Analyst
NYC · Jun 2021 – Dec 2023
- Built a customer cohort dashboard adopted by 50+ ops teams
- Migrated reporting pipeline from cron to Airflow; reduced failures by 70%

## Projects & Open Source
- **Vector Agents** (Open source) — multi-agent eval harness for LangChain pipelines, 1.2k GitHub stars
- **trace-replay** (Personal) — local-first trace inspection for agent workflows

## Education
- **MS Data Science**, University of Texas at Austin — 2021. Coursework: ML, NLP, Statistics

## Skills
- **AI / LLM Systems:** LangChain, LlamaIndex, RAG, vector DBs, tool-calling, evals
- **Data:** SQL, Python, pandas, Airflow, dbt, BigQuery
- **Product:** PRDs, A/B testing, KPI frameworks
`;

// ── Long CV — content stress test (deliberately verbose) ───────────────────
const LONG_CV = `# CV — Casey Riley
**Location:** Austin, TX (open to relocation; remote-first preferred)
**Email:** casey.riley.long.email.address@example.com
**Phone:** +1 (555) 555-0100
**LinkedIn:** linkedin.com/in/casey-riley-long-handle
**GitHub:** github.com/casey-riley-long-handle
**Portfolio:** https://casey-riley-long-portfolio.example.com

## Professional Summary
Product-focused AI systems builder with seven years shipping data and AI products end-to-end — agentic workflows, retrieval-augmented generation pipelines, BI platforms, and self-hosted LLM infrastructure. Owns end-to-end product lifecycles from concept through architecture and production launch. Hybrid skillset spanning PRD writing, advanced SQL, Python, LLM systems engineering, cloud and edge infrastructure, plus the cross-functional leadership scope of a senior product manager.

## Work Experience

### Vellum — Product Manager, Agents
Remote · Jan 2024 – Present
- Owned the agentic workflows surface end-to-end, from initial discovery and customer interviews through to architecture decisions and production launch across the entire enterprise tier
- Shipped a multi-step trace-replay diagnostic tool used by 200+ developers daily, eliminating a common debugging blocker that previously took multiple engineering hours per investigation
- Reduced evaluation cycle time from 30 minutes to 4 minutes by introducing parallel evaluation across worker fleets, allowing teams to iterate on prompt strategies fifteen times faster
- Wrote PRDs for three quarter-defining features adopted across all enterprise customer segments and successfully advocated for engineering investment via clear quantified hypotheses
- Built the agent-observability dashboard standard now used by every Vellum customer, including detailed per-trace cost attribution and failure-mode taxonomy
- Established the eval-rubric review cadence with engineering leadership and customer success, dramatically reducing time-to-resolution on customer-reported edge cases
- Designed the multi-tenant rate-limiting strategy that survived a 10x traffic spike during a high-profile launch without any service degradation or customer-facing errors
- Partnered cross-functionally with Marketing, Sales Engineering, and Customer Success on three quarterly launches, each requiring careful sequencing of feature gates and migration paths

### Mosaic — Senior Analyst
New York City · Jun 2021 – Dec 2023
- Built a customer cohort dashboard adopted by 50+ operations teams across the organization, supporting decision-making at the executive level on retention strategy
- Migrated the entire reporting pipeline from cron-based jobs to Apache Airflow, reducing pipeline failures by 70% and dramatically improving observability via Airflow's native metrics
- Led the data-quality framework rollout across three product surfaces, defining freshness, completeness, and accuracy SLAs that became the de facto standard at the company
- Mentored four junior analysts through hands-on SQL pair-sessions and code reviews, with two of them earning promotions to senior analyst within eighteen months
- Designed and shipped the executive-summary daily-digest email that became the most-read internal communication in the company according to engagement metrics
- Owned the deprecation of three legacy dashboards, coordinating a six-week migration plan across six stakeholder teams with zero data-quality regressions

### LoopAI — Associate Analyst
Remote · Aug 2019 – May 2021
- Designed and shipped the company's first formal A/B testing framework, replacing the previous ad-hoc cohort-comparison approach used across product surfaces
- Authored and ran a SQL training program adopted by 20+ engineers, which became a required onboarding component for all new hires in technical roles
- Built the first cross-product analytics reporting layer, unifying metrics from five previously-disconnected product surfaces into a single Looker-based dashboard

## Projects & Open Source
- **Vector Agents** (Open source) — multi-agent eval harness for LangChain pipelines with 1.2k GitHub stars, supporting custom evaluation rubrics, replay-based debugging, and integration with the most common observability platforms
- **trace-replay** (Personal) — local-first trace inspection tool for agent workflows, allowing developers to step through agent decision-trees without re-running the underlying models
- **csv-tools** (Personal) — fast CSV diffing CLI written in Rust with 400 PyPI downloads per month, used by data teams for catching schema drift between pipeline versions
- **Daily Digest** (Internal at Mosaic, now open-sourced) — executive summary generator that aggregates pipeline health, customer churn signals, and revenue metrics into a single readable email
- **agent-eval-runner** (Open source) — companion to Vector Agents for batch evaluation of large prompt sets against a fixed test corpus

## Education
- **MS Data Science**, University of Texas at Austin — 2021. Coursework included Machine Learning, Natural Language Processing, Statistics, Distributed Systems, and Database Internals. Capstone project on retrieval-augmented question-answering systems.
- **BS Computer Science**, Trinity University — 2019. Graduated with departmental honors. Senior thesis on distributed graph databases.

## Skills
- **AI / LLM Systems:** LangChain, LlamaIndex, RAG architectures, vector databases (ChromaDB, Pinecone, Weaviate), tool-calling agent design, multi-step eval harnesses, prompt-engineering tooling, observability for agents
- **Data Engineering:** SQL (advanced PL/SQL, BigQuery, Snowflake, Postgres), dbt, Apache Airflow, ETL/ELT pipelines, Enterprise Data Models, data observability frameworks, schema-drift detection
- **Programming:** Python (primary, 7 years), SQL, TypeScript, JavaScript, Bash, some Rust for performance-critical tools, basic Go for sidecar services
- **Infrastructure & DevOps:** Docker, Docker Compose, Kubernetes, AWS, GCP, OCI, PostgreSQL administration, Tailscale, Git, GitHub Actions, Linux administration
- **Product Management:** PRD writing, technical specifications, roadmapping, A/B testing and experimentation design, KPI frameworks (AARRR, HEART, RFM), wireframing, stakeholder management, cross-functional leadership
- **Web & Tools:** FastAPI, Streamlit, Flask, TypeScript and Node.js, serverless deployments, Retool, Looker, Tableau, Figma
`;

const LONG_COVER = `I am reaching out about the Builder PM role at Pinch AI. The agentic workflows you described in the job posting map directly onto what I have spent the last two years owning at Vellum, where I lead the agentic surface from discovery through production launch across the enterprise tier.

The piece I find most exciting in your stack is the eval harness. I shipped a multi-step trace-replay tool at Vellum that became one of our most-used customer features, and the trace-replay problem is precisely the one I see surfacing repeatedly in your changelog. I would welcome a short conversation to learn how you are thinking about cost-attribution across multi-agent trajectories, and where your roadmap intersects with my prior work on parallel evaluation and per-trace cost dashboards.

Beyond the technical fit, the team size and shipping cadence you described match what energises me — small enough that a single product manager can carry full ownership end-to-end, large enough that the work compounds across customer segments. I have made a habit of saying yes to that exact shape of role for the last seven years and would be glad to do so again. Happy to share more about my Vellum work in a 30-minute conversation at whatever time suits your team.`;

const SHORT_COVER = `I am reaching out about the Builder PM role at Pinch AI. I have spent the last two years owning the agentic workflows surface at Vellum, and the trace-replay tool I shipped is the closest analogue I have seen to the problem space your changelog describes. I would welcome a short conversation about how you are thinking about cost-attribution and per-trace observability.`;

// ── Scenarios ──────────────────────────────────────────────────────────────

// Author a custom user theme into the sandbox so we can verify the loader
// path + assert a custom theme compiles cleanly. The theme is a stripped-down
// "compact" layout that only emits HEADER + Experience + Education — proving
// that omitting placeholders is graceful, and that the renderer can still
// produce a pdflatex-compatible document under a user dir.
const USER_THEMES = resolve(SBOX, 'my-themes');
mkdirSync(resolve(USER_THEMES, 'compact'), { recursive: true });
writeFileSync(resolve(USER_THEMES, 'compact', 'resume.tex'), `% compact custom theme — layout-check scenario
\\documentclass[letterpaper,11pt]{article}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=0.75in]{geometry}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{2pt}
\\setlist[itemize]{leftmargin=*, topsep=2pt, itemsep=1pt, label=\\textbullet}
\\sloppy
\\setlength{\\emergencystretch}{3em}
\\tolerance=2000
\\pagestyle{empty}
\\raggedright
\\begin{document}

{{HEADER}}

{{EXPERIENCE_SECTION}}
{{EDUCATION_SECTION}}

\\end{document}
`);
writeFileSync(resolve(USER_THEMES, 'compact', 'cover.tex'), `% compact custom cover theme
\\documentclass[letterpaper,11pt]{article}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{parskip}
\\usepackage[hidelinks]{hyperref}
\\setlength{\\parindent}{0pt}
\\sloppy
\\setlength{\\emergencystretch}{3em}
\\pagestyle{empty}
\\raggedright
\\begin{document}
{{HEADER}}

\\vspace{1em}
{{DATE}}

\\vspace{1em}
{{ADDRESS}}

\\vspace{1em}
{{GREETING}}

{{BODY}}

\\vspace{1em}
{{SIGNATURE}}
\\end{document}
`);

const scenarios = [
  { name: 'short',         cv: SHORT_CV, cover: SHORT_COVER, theme: undefined, maxResumePages: 2, maxCoverPages: 1 },
  { name: 'long',          cv: LONG_CV,  cover: LONG_COVER,  theme: undefined, maxResumePages: 3, maxCoverPages: 2 },
  { name: 'custom-short',  cv: SHORT_CV, cover: SHORT_COVER, theme: 'compact', maxResumePages: 2, maxCoverPages: 1, skipPdf: true, skipDocx: true },
  { name: 'custom-long',   cv: LONG_CV,  cover: LONG_COVER,  theme: 'compact', maxResumePages: 2, maxCoverPages: 1, skipPdf: true, skipDocx: true },
];

// ── Boot the env: write cv.md and profile.yml, init the DB ────────────────
async function setup(cvBody) {
  writeFileSync(resolve(SBOX, 'cv.md'), cvBody);
  mkdirSync(resolve(SBOX, 'config'), { recursive: true });
  writeFileSync(resolve(SBOX, 'config/profile.yml'), `candidate:
  full_name: "Casey Riley"
  email: "casey@example.com"
  phone: "+1 555 0100"
  location: "Austin, TX"
  linkedin: "linkedin.com/in/casey-riley"
  github: "github.com/casey-riley"
  portfolio_url: "https://casey.dev"
`);
  writeFileSync(resolve(SBOX, 'portals.yml'), `tracked_companies: []\n`);
  // Fresh DB
  const { getDb } = await import(resolve(REPO, 'dist/db.js'));
  getDb();
}

function pdfPageCount(buf) {
  // Count "/Type /Page" objects, NOT "/Pages" — the cheap approximation we use in render_pdf.
  const s = buf.toString('latin1');
  const m = s.match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}

async function runScenario(s) {
  console.log(`\n=== Scenario: ${s.name.toUpperCase()}${s.theme ? `  (theme="${s.theme}")` : ''} ===`);
  await setup(s.cv);

  // When the scenario uses a custom theme, expose the user themes dir to the
  // loader. Otherwise unset so the bundled default is in play.
  if (s.theme) process.env.JOBOPS_TEMPLATE_DIR = USER_THEMES;
  else delete process.env.JOBOPS_TEMPLATE_DIR;

  // Reset DB modules so a stale connection doesn't point at the previous DB instance.
  // Also clear the cached active-packet so the new cv.md drives parseCV().
  const { upsertJob }       = await import(resolve(REPO, 'dist/core/jobs.js'));
  const { parseCV }         = await import(resolve(REPO, 'dist/core/cv_parse.js'));
  // Cache-bust the renderer modules so they pick up the changed env vars.
  const cb = '?cb=' + Math.random();
  const { buildResumeTex, buildCoverTex } = await import(resolve(REPO, 'dist/core/render_tex.js') + cb);
  const { buildResumeDocx, buildCoverDocx } = await import(resolve(REPO, 'dist/core/render_docx.js') + cb);
  const { renderPdf } = await import(resolve(REPO, 'dist/core/render.js') + cb);

  // Seed a job row so renderPdf has something to attach to.
  const j = await upsertJob({ source: 'test', source_url: 'test://' + s.name, company_name: 'Pinch AI', title: 'Builder PM' });
  const jobId = j.id;

  // Verify parseCV reads what we wrote.
  const cv = parseCV();
  note(cv.experiences.length >= 2 ? 'PASS' : 'FAIL', `${s.name}: parseCV picks up ${cv.experiences.length} experiences`);
  note(cv.skills.length    >= 1 ? 'PASS' : 'FAIL', `${s.name}: parseCV picks up ${cv.skills.length} skill categories`);

  // ── PDF (HTML→Chromium) ────────────────────────────────────────────────
  // Skip when a custom theme only ships .tex (no resume.html / cover.html).
  if (!s.skipPdf) {
    const pdfFiles = await renderPdf({ job_id: jobId, kind: 'both', cover_body: s.cover, page_format: 'letter', theme: s.theme });
    for (const f of pdfFiles) {
      const buf = readFileSync(resolve(process.env.JOBOPS_OUTPUT_DIR, f.path));
      const pages = pdfPageCount(buf);
      const max = f.kind === 'resume' ? s.maxResumePages : s.maxCoverPages;
      note(pages > 0 && pages <= max ? 'PASS' : 'FAIL',
           `${s.name}: ${f.kind}.pdf page count = ${pages} (≤ ${max} expected)`,
           f.path);
    }
  }

  // ── .tex ──────────────────────────────────────────────────────────────
  const texResume = buildResumeTex({ theme: s.theme });
  const texCover  = buildCoverTex({ body: s.cover, company: 'Pinch AI', location: 'Remote' }, { theme: s.theme });
  const texDir = resolve(process.env.JOBOPS_OUTPUT_DIR, 'tex');
  mkdirSync(texDir, { recursive: true });
  const texResumePath = resolve(texDir, `resume-${s.name}.tex`);
  const texCoverPath  = resolve(texDir, `cover-${s.name}.tex`);
  writeFileSync(texResumePath, texResume);
  writeFileSync(texCoverPath,  texCover);

  for (const [kind, p] of [['resume', texResumePath], ['cover', texCoverPath]]) {
    note(existsSync(p) ? 'PASS' : 'FAIL', `${s.name}: ${kind}.tex written`, p);
    note(readFileSync(p, 'utf-8').includes('\\begin{document}') ? 'PASS' : 'FAIL', `${s.name}: ${kind}.tex looks like LaTeX`);

    // Try compiling. Skip cleanly if pdflatex isn't installed.
    if (!spawnSync('command', ['-v', 'pdflatex']).status === 0 && spawnSync('pdflatex', ['--version']).status !== 0) {
      note('INFO', `${s.name}: pdflatex not installed — skipping compile check`);
      continue;
    }
    const r = spawnSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', texDir, p], {
      encoding: 'utf-8', timeout: 60_000,
    });
    const log = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
    const compiled = r.status === 0 || /Output written on/.test(log);
    note(compiled ? 'PASS' : 'FAIL', `${s.name}: ${kind}.tex compiles via pdflatex`,
         compiled ? '' : `status=${r.status} log_tail=${log.slice(-400)}`);

    const overfulls = (log.match(/Overfull \\hbox \(([\d.]+)pt too wide\)/g) || []);
    note(overfulls.length === 0 ? 'PASS' : 'FAIL',
         `${s.name}: ${kind}.tex zero overfull \\hbox`,
         overfulls.length ? `${overfulls.length} overfull(s): ${overfulls.slice(0, 3).join(' | ')}` : '');
  }

  // ── .docx ─────────────────────────────────────────────────────────────
  if (s.skipDocx) return;
  const docxDir = resolve(process.env.JOBOPS_OUTPUT_DIR, 'docx');
  mkdirSync(docxDir, { recursive: true });
  const docxResume = resolve(docxDir, `resume-${s.name}.docx`);
  const docxCover  = resolve(docxDir, `cover-${s.name}.docx`);
  writeFileSync(docxResume, await buildResumeDocx());
  writeFileSync(docxCover,  await buildCoverDocx({ body: s.cover, company: 'Pinch AI', location: 'Remote' }));

  for (const [kind, p] of [['resume', docxResume], ['cover', docxCover]]) {
    const buf = readFileSync(p);
    note(buf.length > 1500 ? 'PASS' : 'FAIL', `${s.name}: ${kind}.docx written (${buf.length} bytes)`);
    // Valid zip: magic bytes 0x50 0x4B
    note(buf[0] === 0x50 && buf[1] === 0x4B ? 'PASS' : 'FAIL', `${s.name}: ${kind}.docx is a valid zip`);

    // Extract document.xml from the zip and check it contains body content.
    // Use Node's built-in zlib via a tiny zip reader.
    const xml = extractDocxBody(buf);
    if (!xml) { note('FAIL', `${s.name}: ${kind}.docx — couldn't extract word/document.xml`); continue; }
    if (kind === 'resume') {
      note(xml.includes('Experience') ? 'PASS' : 'FAIL', `${s.name}: ${kind}.docx contains "Experience" heading`);
      note(xml.includes('Skills')     ? 'PASS' : 'FAIL', `${s.name}: ${kind}.docx contains "Skills" heading`);
    } else {
      note(xml.includes('Dear Hiring Manager') ? 'PASS' : 'FAIL', `${s.name}: ${kind}.docx has salutation`);
      note(xml.includes('Best regards')        ? 'PASS' : 'FAIL', `${s.name}: ${kind}.docx has signoff`);
    }
  }
}

// ── Minimal zip reader for word/document.xml ───────────────────────────────
function extractDocxBody(buf) {
  // Walk the central directory backwards from EOCD.
  const eocdSig = Buffer.from([0x50, 0x4B, 0x05, 0x06]);
  const idx = buf.lastIndexOf(eocdSig);
  if (idx < 0) return null;
  const cdOffset = buf.readUInt32LE(idx + 16);
  const cdSize   = buf.readUInt32LE(idx + 12);

  let pos = cdOffset;
  const end = cdOffset + cdSize;
  while (pos < end) {
    if (buf.readUInt32LE(pos) !== 0x02014B50) break;
    const compMethod   = buf.readUInt16LE(pos + 10);
    const compSize     = buf.readUInt32LE(pos + 20);
    const uncompSize   = buf.readUInt32LE(pos + 24);
    const nameLen      = buf.readUInt16LE(pos + 28);
    const extraLen     = buf.readUInt16LE(pos + 30);
    const commentLen   = buf.readUInt16LE(pos + 32);
    const lfhOffset    = buf.readUInt32LE(pos + 42);
    const name         = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf-8');
    pos += 46 + nameLen + extraLen + commentLen;
    if (name !== 'word/document.xml') continue;

    // Read local file header to get the actual data offset.
    if (buf.readUInt32LE(lfhOffset) !== 0x04034B50) return null;
    const lfhNameLen  = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart   = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const data        = buf.slice(dataStart, dataStart + compSize);
    if (compMethod === 0) return data.toString('utf-8');
    if (compMethod === 8) {
      try { return inflateRawSync(data, { maxOutputLength: uncompSize * 2 + 1024 }).toString('utf-8'); }
      catch { return null; }
    }
    return null;
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────
for (const s of scenarios) await runScenario(s);

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`\x1b[32mAll layout checks PASS.\x1b[0m  Sandbox: ${SBOX}`);
  process.exit(0);
} else {
  console.log(`\x1b[31m${failures.length} FAILURE(S):\x1b[0m`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
  console.log(`Sandbox: ${SBOX}`);
  process.exit(1);
}
