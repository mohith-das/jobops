// Tests for the multi-template theme system.
//
// Exercises the loader (search order, user-dir override), the render_tex
// path with custom themes, malformed-template errors, graceful degradation,
// and the visa-leakage rail still firing on custom-theme output.
//
// The HTML/PDF path is verified by tests/render-persist.test.mjs + the
// scripts/layout-check.mjs E2E run (which also covers a custom theme).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');

let sandbox;       // project root
let userThemeDir;  // MCP_JSA_TEMPLATE_DIR target

// Each test imports from a cache-busted module URL so config + theme state
// reloads cleanly per env-var change.
function fresh(modulePath) {
  return import(`${modulePath}?cb=${Math.random()}_${Date.now()}`);
}

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-themes-'));
  mkdirSync(resolve(sandbox, 'config'), { recursive: true });
  writeFileSync(resolve(sandbox, 'cv.md'), `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com
**Phone:** +1 555 0100

## Professional Summary
Builder PM with engineering teeth.

## Work Experience
### Vellum — Product Manager
Remote · 2024 – Present
- Owned the agentic workflows surface
- Shipped trace-replay tool

## Education
- **MS Data Science**, UT Austin — 2021

## Skills
- **AI / LLM Systems:** LangChain, RAG, evals
`);
  writeFileSync(resolve(sandbox, 'config/profile.yml'), `candidate:
  full_name: "Casey Riley"
  email: "casey@example.com"
  phone: "+1 555 0100"
  location: "Austin, TX"
`);
  writeFileSync(resolve(sandbox, 'portals.yml'), `tracked_companies: []\n`);

  userThemeDir = resolve(sandbox, 'my-themes');
  mkdirSync(userThemeDir, { recursive: true });

  // Author a minimal-but-valid custom theme that only renders header + experience.
  // Drops Summary/Skills/Projects/Education/Certifications by omitting placeholders.
  const compactDir = resolve(userThemeDir, 'compact');
  mkdirSync(compactDir, { recursive: true });
  writeFileSync(resolve(compactDir, 'resume.tex'), `% custom compact theme
\\documentclass[letterpaper,11pt]{article}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=0.75in]{geometry}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{2pt}
\\sloppy
\\setlength{\\emergencystretch}{3em}
\\pagestyle{empty}
\\raggedright
\\begin{document}

{{HEADER}}

{{EXPERIENCE_SECTION}}

\\end{document}
`);
  writeFileSync(resolve(compactDir, 'cover.tex'), `% custom compact cover
\\documentclass[letterpaper,11pt]{article}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1in]{geometry}
\\usepackage[hidelinks]{hyperref}
\\pagestyle{empty}
\\begin{document}
{{HEADER}}\\par\\vspace{1em}
{{DATE}}\\par\\vspace{1em}
{{ADDRESS}}\\par\\vspace{1em}
{{GREETING}}\\par\\vspace{0.5em}
{{BODY}}\\par\\vspace{1em}
{{SIGNATURE}}
\\end{document}
`);

  // A malformed theme — missing \\documentclass and \\begin{document}.
  const badDir = resolve(userThemeDir, 'broken');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(resolve(badDir, 'resume.tex'), `% this is not a valid LaTeX document\nhello world\n`);

  // A user-dir override of "default" — placeholder content so we can tell it apart.
  const overrideDir = resolve(userThemeDir, 'default');
  mkdirSync(overrideDir, { recursive: true });
  writeFileSync(resolve(overrideDir, 'resume.tex'), `% USER OVERRIDE MARKER\n\\documentclass[letterpaper,11pt]{article}\n\\begin{document}\n{{HEADER}}\n\\end{document}\n`);

  process.env.MCP_JSA_DATA_DIR     = resolve(sandbox, 'data');
  process.env.MCP_JSA_OUTPUT_DIR   = resolve(sandbox, 'output');
  process.env.MCP_JSA_PROJECT_ROOT = sandbox;
  // Default to NO user-dir override; tests that need it set it then unset it.
  delete process.env.MCP_JSA_TEMPLATE_DIR;
  delete process.env.MCP_JSA_DEFAULT_TEMPLATE;
  const { getDb } = await fresh('../dist/db.js');
  getDb();
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

// ── Theme discovery ────────────────────────────────────────────────────────

test('listThemes returns the bundled default when no user dir is set', async () => {
  delete process.env.MCP_JSA_TEMPLATE_DIR;
  const { listThemes } = await fresh('../dist/core/templates.js');
  const themes = listThemes();
  assert.ok(themes.length >= 1, 'at least the bundled default theme is visible');
  const def = themes.find(t => t.name === 'default');
  assert.ok(def, '"default" theme is present');
  assert.equal(def.source, 'bundled');
  assert.ok(def.files['resume.tex'], 'default theme has resume.tex');
  assert.ok(def.files['cover.tex'],  'default theme has cover.tex');
  assert.ok(def.files['resume.html'],'default theme has resume.html');
  assert.ok(def.files['cover.html'], 'default theme has cover.html');
});

test('listThemes surfaces user-dir themes alongside bundled', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { listThemes } = await fresh('../dist/core/templates.js');
  const themes = listThemes();
  const names  = themes.map(t => t.name);
  assert.ok(names.includes('compact'), 'user "compact" theme listed');
  assert.ok(names.includes('default'), '"default" theme listed (user override)');
  // The user "default" SHADOWS the bundled default — only one entry.
  const defaults = themes.filter(t => t.name === 'default');
  assert.equal(defaults.length, 1, 'only one "default" entry');
  assert.equal(defaults[0].source, 'user', 'user "default" wins over bundled');
});

test('listThemes also includes the bundled "broken" theme even though it is malformed', async () => {
  // The loader's job is discovery; validation happens at load-time.
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { listThemes } = await fresh('../dist/core/templates.js');
  assert.ok(listThemes().some(t => t.name === 'broken'),
    '"broken" is discoverable even if its files are malformed');
});

// ── Theme resolution ───────────────────────────────────────────────────────

test('resolveTheme finds bundled "default" with no user dir', async () => {
  delete process.env.MCP_JSA_TEMPLATE_DIR;
  const { resolveTheme } = await fresh('../dist/core/templates.js');
  const t = resolveTheme('default');
  assert.equal(t.name, 'default');
  assert.equal(t.source, 'bundled');
});

test('resolveTheme picks the user-dir version when the name collides', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { resolveTheme } = await fresh('../dist/core/templates.js');
  const t = resolveTheme('default');
  assert.equal(t.source, 'user');
  assert.ok(t.dir.includes('my-themes/default'));
});

test('resolveTheme errors clearly with the theme name when not found', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { resolveTheme } = await fresh('../dist/core/templates.js');
  assert.throws(() => resolveTheme('does-not-exist'),
    err => /Unknown template theme "does-not-exist"/.test(err.message)
        && /Available:/.test(err.message));
});

test('resolveTheme rejects unsafe names', async () => {
  const { resolveTheme } = await fresh('../dist/core/templates.js');
  assert.throws(() => resolveTheme('../etc/passwd'), /illegal characters/);
  assert.throws(() => resolveTheme(''), /non-empty string/);
});

// ── Template loading + validation ──────────────────────────────────────────

test('loadTemplate returns the body of bundled default/resume.tex', async () => {
  delete process.env.MCP_JSA_TEMPLATE_DIR;
  const { loadTemplate } = await fresh('../dist/core/templates.js');
  const t = loadTemplate('default', 'resume.tex');
  assert.match(t.body, /\\documentclass/);
  assert.match(t.body, /\\begin\{document\}/);
  assert.match(t.body, /\{\{HEADER\}\}/);
  assert.equal(t.theme.name, 'default');
  assert.equal(t.filename, 'resume.tex');
});

test('loadTemplate errors with theme name when the file is missing in the theme', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { loadTemplate } = await fresh('../dist/core/templates.js');
  // compact only ships resume.tex + cover.tex — no HTML files.
  assert.throws(() => loadTemplate('compact', 'resume.html'),
    err => /Theme "compact"/.test(err.message)
        && /missing resume\.html/.test(err.message));
});

test('loadTemplate errors clearly when the template is malformed', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { loadTemplate } = await fresh('../dist/core/templates.js');
  assert.throws(() => loadTemplate('broken', 'resume.tex'),
    err => /template "broken\/resume\.tex"/.test(err.message)
        && /malformed/.test(err.message)
        && /\\documentclass/.test(err.message));
});

// ── Placeholder substitution ───────────────────────────────────────────────

test('fillTemplate replaces known placeholders and drops unknown ones', async () => {
  const { fillTemplate } = await fresh('../dist/core/templates.js');
  const tpl = `Hello {{NAME}}, your {{ROLE}} is {{MISSING}}.`;
  const out = fillTemplate(tpl, { NAME: 'Casey', ROLE: 'PM' });
  assert.equal(out, 'Hello Casey, your PM is .');
});

test('fillTemplate is single-pass — placeholder content does not re-expand', async () => {
  const { fillTemplate } = await fresh('../dist/core/templates.js');
  const out = fillTemplate('A={{A}} B={{B}}', { A: '{{B}}', B: 'final' });
  // {{A}} → "{{B}}" (literal), then no second pass on the substituted text.
  assert.equal(out, 'A={{B}} B=final');
});

// ── render_tex with default vs custom themes ───────────────────────────────

test('buildResumeTex with default theme contains every section block', async () => {
  delete process.env.MCP_JSA_TEMPLATE_DIR;
  delete process.env.MCP_JSA_DEFAULT_TEMPLATE;
  const { buildResumeTex } = await fresh('../dist/core/render_tex.js');
  const tex = buildResumeTex();
  // Default has Summary + Skills + Experience + Education sections (Projects
  // missing in our cv.md → empty placeholder, OK).
  assert.match(tex, /\\section\*\{Summary\}/);
  assert.match(tex, /\\section\*\{Skills\}/);
  assert.match(tex, /\\section\*\{Experience\}/);
  assert.match(tex, /\\section\*\{Education\}/);
  // Real candidate data made it in.
  assert.match(tex, /Casey Riley/);
  assert.match(tex, /Vellum/);
});

test('buildResumeTex with theme="compact" only emits HEADER + Experience', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { buildResumeTex } = await fresh('../dist/core/render_tex.js');
  const tex = buildResumeTex({ theme: 'compact' });
  // Compact omits Summary/Skills/Education/Projects placeholders entirely.
  assert.doesNotMatch(tex, /\\section\*\{Summary\}/, 'no Summary section');
  assert.doesNotMatch(tex, /\\section\*\{Skills\}/,  'no Skills section');
  assert.doesNotMatch(tex, /\\section\*\{Education\}/, 'no Education section');
  // But HEADER + Experience are present and contain real content.
  assert.match(tex, /Casey Riley/);
  assert.match(tex, /\\section\*\{Experience\}/);
  assert.match(tex, /Vellum/);
});

test('buildCoverTex with theme="compact" produces a valid pdflatex-able document', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { buildCoverTex } = await fresh('../dist/core/render_tex.js');
  const tex = buildCoverTex({
    body:     'Reaching out about the role. Excited about your work.\n\nLooking forward.',
    company:  'Acme',
    location: 'Remote',
  }, { theme: 'compact' });
  assert.match(tex, /\\documentclass/);
  assert.match(tex, /\\begin\{document\}/);
  assert.match(tex, /\\end\{document\}/);
  // Both paragraphs land in the body.
  assert.match(tex, /Reaching out/);
  assert.match(tex, /Looking forward/);
  // Greeting + signature are filled.
  assert.match(tex, /Dear Hiring Manager,/);
  assert.match(tex, /Best regards,/);
  assert.match(tex, /Casey Riley/);
});

test('unknown theme errors before any output is produced', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { buildResumeTex } = await fresh('../dist/core/render_tex.js');
  assert.throws(() => buildResumeTex({ theme: 'no-such-theme' }),
    err => /Unknown template theme "no-such-theme"/.test(err.message));
});

test('malformed theme errors with the theme name and file path', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { buildResumeTex } = await fresh('../dist/core/render_tex.js');
  assert.throws(() => buildResumeTex({ theme: 'broken' }),
    err => /theme="broken"/.test(err.message)
        && /malformed/.test(err.message));
});

// ── Visa-leakage rail still fires regardless of theme ─────────────────────

test('visa scan still catches a leak in a custom-theme cover.tex', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR = userThemeDir;
  const { buildCoverTex } = await fresh('../dist/core/render_tex.js');
  const { scanForVisaLeakage } = await fresh('../dist/core/outreach_safety.js');
  const tex = buildCoverTex({
    body:     'I would require H1B sponsorship to join your team.',
    company:  'Acme',
    location: 'Remote',
  }, { theme: 'compact' });
  // The .tex is generated, but the caller MUST scan before writing — and the
  // visa term shows up in the substituted BODY exactly as we'd expect.
  const leaks = scanForVisaLeakage(tex);
  assert.ok(leaks.length > 0, 'custom theme does not bypass the visa rail');
  assert.ok(leaks.some(l => l.rule === 'no_visa_mentions'));
});

// ── effectiveDefaultTemplate + MCP_JSA_DEFAULT_TEMPLATE ───────────────────

test('effectiveDefaultTemplate returns "default" by default', async () => {
  delete process.env.MCP_JSA_DEFAULT_TEMPLATE;
  delete process.env.MCP_JSA_TEMPLATE_DIR;
  const { effectiveDefaultTemplate } = await fresh('../dist/core/templates.js');
  assert.equal(effectiveDefaultTemplate(), 'default');
});

test('effectiveDefaultTemplate honours MCP_JSA_DEFAULT_TEMPLATE when valid', async () => {
  process.env.MCP_JSA_TEMPLATE_DIR     = userThemeDir;
  process.env.MCP_JSA_DEFAULT_TEMPLATE = 'compact';
  const { effectiveDefaultTemplate } = await fresh('../dist/core/templates.js');
  assert.equal(effectiveDefaultTemplate(), 'compact');
  delete process.env.MCP_JSA_DEFAULT_TEMPLATE;
});

test('effectiveDefaultTemplate falls back to "default" when configured value is missing', async () => {
  process.env.MCP_JSA_DEFAULT_TEMPLATE = 'no-such-theme';
  delete process.env.MCP_JSA_TEMPLATE_DIR;
  // We expect a stderr warning but no throw — the function must return "default".
  const origErr = process.stderr.write.bind(process.stderr);
  const warnings = [];
  process.stderr.write = (b) => { warnings.push(String(b)); return true; };
  try {
    const { effectiveDefaultTemplate } = await fresh('../dist/core/templates.js');
    assert.equal(effectiveDefaultTemplate(), 'default');
  } finally {
    process.stderr.write = origErr;
    delete process.env.MCP_JSA_DEFAULT_TEMPLATE;
  }
  assert.ok(warnings.some(w => /MCP_JSA_DEFAULT_TEMPLATE/.test(w)),
    'a warning is printed to stderr when the configured default is missing');
});
