// A theme that comments a placeholder out (`% {{SUMMARY_SECTION}}`) must
// genuinely drop that section. Previously fillTemplate substituted inside the
// LaTeX comment, and because section values are multi-line, every line after
// the first escaped the comment — the Summary rendered anyway.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-commented-'));
  mkdirSync(resolve(sandbox, 'config'), { recursive: true });
  writeFileSync(resolve(sandbox, 'cv.md'), `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com

## Professional Summary
Builder PM with engineering teeth.

## Work Experience
### Vellum — Product Manager
Remote · 2024 – Present
- Owned the agentic workflows surface

## Education
- **MS Data Science**, UT Austin — 2021

## Skills
- **AI / LLM Systems:** LangChain, RAG, evals
`);
  writeFileSync(resolve(sandbox, 'config/profile.yml'), `candidate:
  full_name: "Casey Riley"
  email: "casey@example.com"
  location: "Austin, TX"
`);
  writeFileSync(resolve(sandbox, 'portals.yml'), `tracked_companies: []\n`);

  // A jakes-style user theme with the SUMMARY placeholder commented out.
  const themeDir = resolve(sandbox, 'themes', 'jakes');
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(resolve(themeDir, 'resume.tex'), `% jakes theme — summary deliberately disabled
\\documentclass[letterpaper,11pt]{article}
\\setlength{\\parindent}{0pt}
\\pagestyle{empty}
\\begin{document}
{{HEADER}}

% {{SUMMARY_SECTION}}
{{EXPERIENCE_SECTION}}
{{EDUCATION_SECTION}}
{{SKILLS_SECTION}}
\\end{document}
`);

  process.env.JOBOPS_DATA_DIR     = resolve(sandbox, 'data');
  process.env.JOBOPS_OUTPUT_DIR   = resolve(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  process.env.JOBOPS_TEMPLATE_DIR = resolve(sandbox, 'themes');
  delete process.env.JOBOPS_DEFAULT_TEMPLATE;
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

test('a %-commented placeholder drops the section from the generated .tex', async () => {
  const { buildResumeTex } = await import('../dist/core/render_tex.js');
  const tex = buildResumeTex({ theme: 'jakes' });

  assert.doesNotMatch(tex, /\\section\*\{Summary\}/, 'Summary section heading must not render');
  assert.doesNotMatch(tex, /engineering teeth/,      'Summary body must not render');
  assert.match(tex, /% \{\{SUMMARY_SECTION\}\}/,     'the commented placeholder line stays verbatim');
  // Uncommented placeholders still fill normally.
  assert.match(tex, /\\section\*\{Experience\}/);
  assert.match(tex, /\\section\*\{Education\}/);
  assert.match(tex, /\\section\*\{Skills\}/);
});

test('fillTemplate latex-comment mode: comment detection rules', async () => {
  const { fillTemplate } = await import('../dist/core/templates.js');
  const values = { A: 'sub-A', B: 'line1\nline2' };

  // Whole-line comment: skipped.
  assert.equal(fillTemplate('% {{B}}', values, { comments: 'latex' }), '% {{B}}');
  // Placeholder BEFORE the % on the same line: substituted; after: skipped.
  assert.equal(fillTemplate('{{A}} % {{B}}', values, { comments: 'latex' }), 'sub-A % {{B}}');
  // \% is an escaped percent, not a comment — substitution proceeds.
  assert.equal(fillTemplate('100\\% {{A}}', values, { comments: 'latex' }), '100\\% sub-A');
  // \\% is a line break followed by a real comment — skipped.
  assert.equal(fillTemplate('x\\\\% {{A}}', values, { comments: 'latex' }), 'x\\\\% {{A}}');
  // A comment on a previous line does not bleed into the next line.
  assert.equal(fillTemplate('% c\n{{A}}', values, { comments: 'latex' }), '% c\nsub-A');
  // Without the option, behavior is unchanged (HTML path relies on this default).
  assert.equal(fillTemplate('% {{A}}', values), '% sub-A');
});
