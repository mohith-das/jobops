// Regression tests for the stale-render bug: renders must reflect the CURRENT
// state, not a snapshot from first render.
//   A. persist materials → render → change materials → render again → outputs differ
//      and contain the new content (not the old).
//   B. two different jobs with different materials render differently.
//   C. a chat edit to the career packet (education) shows up in the next render
//      without an explicit sync-back to cv.md.
//   D. overlay unit behavior: slug matching, unknown slugs never invent a role,
//      LaTeX-contract sections parse, normalization unescapes specials.
//
// No Playwright here — the .tex path shares cvForRender with the PDF/docx paths.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-tailored-'));
  mkdirSync(resolve(sandbox, 'config'), { recursive: true });
  writeFileSync(resolve(sandbox, 'cv.md'), `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com

## Professional Summary
Builder PM with engineering teeth.

## Work Experience

### Vellum — Product Manager, Agents
Remote · Jan 2024 – Present
- Owned the agentic workflows surface end-to-end
- Shipped a trace-replay tool used daily

### Mosaic — Senior Analyst
NYC · Jun 2023 – Dec 2023
- Built a customer cohort dashboard
- Migrated reporting pipeline from cron to Airflow

## Projects & Open Source
- **Vector Agents** (Open source) — multi-agent eval harness

## Education
- **MS Data Science**, UT Austin — 1999

## Skills
- **AI / LLM Systems:** LangChain, RAG, evals
- **Data:** SQL, Python, Airflow
`);
  writeFileSync(resolve(sandbox, 'config/profile.yml'), `candidate:
  full_name: "Casey Riley"
  email: "casey@example.com"
  location: "Austin, TX"
`);
  writeFileSync(resolve(sandbox, 'portals.yml'), `tracked_companies: []\n`);

  process.env.JOBOPS_DATA_DIR     = resolve(sandbox, 'data');
  process.env.JOBOPS_OUTPUT_DIR   = resolve(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  delete process.env.JOBOPS_TEMPLATE_DIR;
  delete process.env.JOBOPS_DEFAULT_TEMPLATE;
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

async function seedJob(title) {
  const { upsertJob } = await import('../dist/core/jobs.js');
  const r = await upsertJob({ source: 'test', source_url: `test://${title}`, company_name: 'Vellum', title });
  return r.id;
}

async function persistMaterials(job_id, materials) {
  const { generateMaterialsTool } = await import('../dist/mcp/tools/generate_materials.js');
  const res = await generateMaterialsTool.handler({ job_id, mode: 'chat', materials });
  assert.equal(res.isError, undefined, JSON.stringify(res));
  return res;
}

// ── A. Materials regression: persist → render → change → render → differs ──

test('render reflects the current materials_v: changed materials change the output', async () => {
  const { buildResumeTex } = await import('../dist/core/render_tex.js');
  const { getDb } = await import('../dist/db.js');
  const jobId = await seedJob('Builder PM');

  await persistMaterials(jobId, {
    tagline: 'Agent infrastructure PM',
    experience_bullets: {
      // LaTeX-contract shape (tailoring_rules.md): \resumeItem wrapper, \textbf, escaped %
      vellum:        ['\\resumeItem{Drove \\textbf{agent adoption} to 90\\% of enterprise accounts}'],
      previous_role: ['Cut reporting latency by eighty percent'],
    },
    projects_section: '- **Vector Agents** — rebuilt the eval harness for multi-agent runs',
    skills_section:   '\\item \\textbf{AI / LLM Systems:} agents, evals, RAG',
    cover_letter_body: 'Plain prose body about the team.',
  });

  const tex1 = buildResumeTex({ job_id: jobId });
  assert.match(tex1, /agent adoption/,         'v1 vellum bullet must appear');
  assert.match(tex1, /90\\%/,                  'escaped specials must survive exactly once');
  assert.match(tex1, /Cut reporting latency by eighty percent/, 'previous_role slug must hit the second experience');
  assert.match(tex1, /rebuilt the eval harness for multi-agent runs/, 'tailored project must replace the base project');
  assert.match(tex1, /agents, evals, RAG/,     'tailored skills must replace the base skills');
  assert.match(tex1, /Agent infrastructure PM/, 'tailored tagline surfaces as the summary');
  assert.doesNotMatch(tex1, /Owned the agentic workflows surface/, 'base bullet for the tailored role must be replaced');

  // Change the materials (the v1 → v2 → v3 flow from the bug report).
  await persistMaterials(jobId, {
    experience_bullets: { vellum: ['Scaled trace-replay to forty enterprise tenants'] },
    projects_section:   '- **Latency Lab** — built a load-testing rig for agent traces',
    cover_letter_body:  'Plain prose body, second draft.',
  });
  const row = getDb().prepare(`SELECT materials_v FROM applications WHERE job_id = ?`).get(jobId);
  assert.equal(row.materials_v, 2);

  const tex2 = buildResumeTex({ job_id: jobId });
  assert.notEqual(tex2, tex1, 'render after a materials change must differ');
  assert.match(tex2, /Scaled trace-replay to forty enterprise tenants/);
  assert.match(tex2, /Latency Lab/);
  assert.doesNotMatch(tex2, /agent adoption/, 'v1 bullet must be gone');
  assert.doesNotMatch(tex2, /rebuilt the eval harness for multi-agent runs/, 'v1 project must be gone');
});

// ── B. Two different jobs must not share output ─────────────────────────────

test('two jobs with different materials render different documents', async () => {
  const { buildResumeTex } = await import('../dist/core/render_tex.js');
  const jobA = await seedJob('Forward Deployed Engineer');
  const jobB = await seedJob('Data Platform PM');

  await persistMaterials(jobA, {
    experience_bullets: { vellum: ['Embedded with three enterprise customers to ship agent rollouts'] },
    cover_letter_body: 'Body A.',
  });
  await persistMaterials(jobB, {
    experience_bullets: { vellum: ['Owned the warehouse-native analytics roadmap'] },
    cover_letter_body: 'Body B.',
  });

  const texA = buildResumeTex({ job_id: jobA });
  const texB = buildResumeTex({ job_id: jobB });
  assert.notEqual(texA, texB);
  assert.match(texA, /Embedded with three enterprise customers/);
  assert.doesNotMatch(texA, /warehouse-native analytics roadmap/);
  assert.match(texB, /warehouse-native analytics roadmap/);
});

// ── C. Packet currency: chat edits reach the next render ───────────────────

test('a chat edit to the packet (education) shows up in the next render', async () => {
  const { seedCareerPacketFromFiles, editPacketItem, getActiveCareerPacket } = await import('../dist/core/profile.js');
  const { buildResumeTex } = await import('../dist/core/render_tex.js');

  const seeded = await seedCareerPacketFromFiles({ mode: 'reseed' });
  assert.ok(seeded.created);

  const texBefore = buildResumeTex();
  assert.match(texBefore, /1999/, 'baseline education year from cv.md');

  // The user flow from the bug report: education edited via chat, no sync-back.
  await editPacketItem('education', 1, "**MS Data Science** — UT Austin (2027). Dean's List");
  assert.equal(getActiveCareerPacket().origin, 'chat_edit');

  const texAfter = buildResumeTex();
  assert.notEqual(texAfter, texBefore, 'render after a packet edit must differ');
  assert.match(texAfter, /2027/);
  assert.match(texAfter, /Dean's List/);
  assert.doesNotMatch(texAfter, /1999/, 'stale education year must be gone');
});

// ── D. Overlay unit behavior ────────────────────────────────────────────────

test('matchExperienceSlug: ordinals and employer-name slugs; unknown slugs never invent a role', async () => {
  const { matchExperienceSlug, applyTailoredOverlay } = await import('../dist/core/render_source.js');
  const experiences = [
    { company: 'Vellum', role: 'Product Manager, Agents', period: '', location: '', bullets: ['base A'] },
    { company: 'Mosaic', role: 'Senior Analyst',           period: '', location: '', bullets: ['base B'] },
  ];
  assert.equal(matchExperienceSlug(experiences, 'current_role'), 0);
  assert.equal(matchExperienceSlug(experiences, 'previous_role'), 1);
  assert.equal(matchExperienceSlug(experiences, 'vellum'), 0);
  assert.equal(matchExperienceSlug(experiences, 'mosaic_senior_analyst'), 1);
  assert.equal(matchExperienceSlug(experiences, 'globocorp'), -1);

  const base = {
    name: 'X', phone: '', email: '', location: '', linkedin_url: '', linkedin_display: '',
    portfolio_url: '', portfolio_display: '', summary: 's', competencies: [],
    experiences, projects: [], education: [], certifications: [], skills: [],
  };
  const out = applyTailoredOverlay(base, { experience_bullets: { globocorp: ['invented bullet'] } });
  assert.deepEqual(out.experiences[0].bullets, ['base A'], 'unknown slug must not touch any role');
  assert.deepEqual(out.experiences[1].bullets, ['base B']);
});

test('LaTeX-contract sections parse; unparseable sections fall back to base', async () => {
  const { parseTailoredProjects, parseTailoredSkills, normalizeTailoredText } = await import('../dist/core/render_source.js');

  const projects = parseTailoredProjects(
    '\\resumeProjectHeading\n' +
    '  {\\textbf{Vector Agents} --- multi-agent eval harness $|$ \\href{https://x}{repo}}{2024}\n' +
    '  \\resumeItemListStart\n' +
    '    \\resumeItem{Built the \\textbf{eval harness} used by 12 teams}\n' +
    '  \\resumeItemListEnd\n');
  assert.equal(projects.length, 1);
  assert.equal(projects[0].title, 'Vector Agents');
  assert.match(projects[0].description, /multi-agent eval harness/);
  assert.match(projects[0].description, /eval harness\*\* used by 12 teams|\*\*eval harness\*\*/);

  const skills = parseTailoredSkills('\\item \\textbf{Product:} roadmaps, PRDs\n\\item \\textbf{AI / LLM Systems:} agents');
  assert.deepEqual(skills.map(s => s.category), ['Product', 'AI / LLM Systems']);
  assert.equal(skills[0].items, 'roadmaps, PRDs');

  assert.equal(parseTailoredProjects('free prose with no structure').length, 0, 'unparseable → empty → caller keeps base');
  assert.equal(normalizeTailoredText('\\resumeItem{Cut spend by \\textbf{85\\%} \\& time by 40\\_pts}'),
               'Cut spend by **85%** & time by 40_pts');
});
