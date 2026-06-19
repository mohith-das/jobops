// Theme discovery + loading for the resume + cover renderers.
//
// A "theme" is a directory under `templates/themes/<name>/` containing any of:
//   resume.tex, cover.tex, resume.html, cover.html
//
// Search order, highest priority first:
//   1. <userTemplateDir>/<name>/                   — JOBOPS_TEMPLATE_DIR
//   2. <installDir>/templates/themes/<name>/       — bundled with the package
//
// A user can override "default" by dropping their own `default/` folder into
// JOBOPS_TEMPLATE_DIR. A user can also add brand-new themes that only live in
// their dir. Per-call `template=<name>` argument picks which theme to render.
//
// Each theme file is a plain-text template with {{PLACEHOLDER}} slots; the
// renderer pre-builds the LaTeX/HTML for each block and substitutes them in.
// Placeholders the renderer doesn't fill stay as empty strings (graceful
// degradation — drop a placeholder from your template to drop that section).
// In .tex templates, commenting a placeholder out (`% {{SUMMARY_SECTION}}`)
// drops the section too — substitution skips LaTeX comments.
// Placeholders the *template* doesn't reference are simply not used.
//
// Structural sanity checks (`validateTemplate`) catch the obvious malformed
// cases (missing \documentclass, missing <html> shell, unclosed document) and
// throw with the theme name in the message — no cryptic pdflatex backtrace.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

import { config } from '../config.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type TemplateFormat = 'resume.tex' | 'cover.tex' | 'resume.html' | 'cover.html';

export interface ThemeInfo {
  name:   string;
  /** Where the theme directory lives. */
  dir:    string;
  /** Which source the theme came from. */
  source: 'bundled' | 'user';
  /** Map of available template files in this theme dir. */
  files: Partial<Record<TemplateFormat, string>>;
}

export interface ResolvedTemplate {
  /** Raw template body (verbatim file contents). */
  body:     string;
  /** Theme this came from (after user-dir override resolution). */
  theme:    ThemeInfo;
  /** Which file under the theme dir was loaded. */
  filename: TemplateFormat;
}

// ── Public API ──────────────────────────────────────────────────────────────

const BUNDLED_THEMES_DIR = () => resolve(config.installDir, 'templates', 'themes');

/**
 * Read JOBOPS_TEMPLATE_DIR live from process.env so tests + tools that flip
 * the env var in-process see the change immediately. The config singleton
 * caches the boot-time value for display purposes (doctor, connect); this
 * function is the source of truth for the loader.
 */
const USER_THEMES_DIR = (): string | null => {
  const raw = process.env.JOBOPS_TEMPLATE_DIR?.trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
};

/** Live read of JOBOPS_DEFAULT_TEMPLATE (see comment on USER_THEMES_DIR). */
const DEFAULT_TEMPLATE_NAME = (): string => {
  const raw = process.env.JOBOPS_DEFAULT_TEMPLATE?.trim();
  return raw || 'default';
};

/**
 * List every theme available — user dir first, bundled second. When the same
 * name appears in both, the user version wins and the bundled one is shadowed
 * (not returned). Themes with no recognised files are skipped.
 */
export function listThemes(): ThemeInfo[] {
  const seen = new Map<string, ThemeInfo>();   // name → first-seen ThemeInfo
  const userDir = USER_THEMES_DIR();
  if (userDir && existsSync(userDir)) {
    for (const t of scanDir(userDir, 'user')) if (!seen.has(t.name)) seen.set(t.name, t);
  }
  const bundled = BUNDLED_THEMES_DIR();
  if (existsSync(bundled)) {
    for (const t of scanDir(bundled, 'bundled')) if (!seen.has(t.name)) seen.set(t.name, t);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return the resolved theme directory + recognised files for `name`. Throws
 * with a clear message if the theme is not found anywhere (the name is quoted
 * verbatim in the error).
 */
export function resolveTheme(name: string): ThemeInfo {
  if (!name || typeof name !== 'string') {
    throw new Error(`resolveTheme: theme name must be a non-empty string (got ${JSON.stringify(name)})`);
  }
  const safe = /^[A-Za-z0-9_.-]+$/.test(name);
  if (!safe) {
    throw new Error(`resolveTheme: theme name "${name}" contains illegal characters — allowed: letters, digits, underscore, dash, dot`);
  }
  const userDir = USER_THEMES_DIR();
  if (userDir) {
    const candidate = resolve(userDir, name);
    if (isThemeDir(candidate)) return readTheme(candidate, name, 'user');
  }
  const bundled = resolve(BUNDLED_THEMES_DIR(), name);
  if (isThemeDir(bundled)) return readTheme(bundled, name, 'bundled');

  const available = listThemes().map(t => t.name).join(', ') || '(none)';
  const hint = userDir
    ? `Searched ${userDir}/${name}/ and ${BUNDLED_THEMES_DIR()}/${name}/`
    : `Searched ${BUNDLED_THEMES_DIR()}/${name}/ (set JOBOPS_TEMPLATE_DIR to add a user themes dir)`;
  throw new Error(`Unknown template theme "${name}". Available: ${available}. ${hint}`);
}

/**
 * Load a specific file (e.g. "resume.tex") from a theme. Throws with the theme
 * name embedded when the file is missing or when structural sanity checks fail.
 */
export function loadTemplate(themeName: string, filename: TemplateFormat): ResolvedTemplate {
  const theme = resolveTheme(themeName);
  const rel = theme.files[filename];
  if (!rel) {
    const have = Object.keys(theme.files).join(', ') || '(no template files)';
    throw new Error(`Theme "${themeName}" (${theme.source}, at ${theme.dir}) is missing ${filename}. Files present: ${have}.`);
  }
  const abs  = resolve(theme.dir, rel);
  let body: string;
  try { body = readFileSync(abs, 'utf-8'); }
  catch (err: any) {
    throw new Error(`Failed to read template "${themeName}/${filename}" at ${abs}: ${err?.message ?? err}`);
  }
  validateTemplate(themeName, filename, body, abs);
  return { body, theme, filename };
}

export interface FillOptions {
  /**
   * 'latex' — a placeholder sitting after an unescaped `%` on its line is inside
   * a LaTeX comment: leave it verbatim instead of substituting. Substituted
   * values are often multi-line, so expanding inside a comment would let every
   * line after the first escape the comment — a commented-out placeholder must
   * genuinely drop the section.
   */
  comments?: 'latex';
}

/**
 * Substitute `{{KEY}}` placeholders. Keys not present in `values` are replaced
 * with empty string (degrade gracefully). Values not referenced by the template
 * are ignored. The order of substitution is deterministic so that a value
 * containing `{{X}}` does not re-trigger a second pass.
 */
export function fillTemplate(body: string, values: Record<string, string>, opts: FillOptions = {}): string {
  // Single-pass: split on placeholder regex, substitute matched keys, reassemble.
  // This guarantees a value containing "{{FOO}}" is treated as literal text.
  return body.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key, offset) => {
    if (opts.comments === 'latex' && inLatexComment(body, offset)) return match;
    return values[key] ?? '';
  });
}

/** True when `offset` falls after an unescaped `%` on its line (LaTeX comment). */
function inLatexComment(body: string, offset: number): boolean {
  const lineStart = body.lastIndexOf('\n', offset - 1) + 1;
  const prefix = body.slice(lineStart, offset);
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== '%') continue;
    // `\%` is an escaped percent, not a comment — but `\\%` is a line break
    // followed by a real comment. Odd backslash count = escaped.
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && prefix[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

/**
 * Resolve the effective default theme: JOBOPS_DEFAULT_TEMPLATE if set, else
 * "default". Falls back to "default" with a stderr warning if the configured
 * default is missing — never crashes the renderer at boot.
 */
export function effectiveDefaultTemplate(): string {
  const configured = DEFAULT_TEMPLATE_NAME();
  try { resolveTheme(configured); return configured; }
  catch (err: any) {
    if (configured !== 'default') {
      // eslint-disable-next-line no-console
      console.error(`[templates] WARN: JOBOPS_DEFAULT_TEMPLATE="${configured}" not found — falling back to "default". ${err?.message ?? ''}`);
    }
    return 'default';
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

const RECOGNISED: TemplateFormat[] = ['resume.tex', 'cover.tex', 'resume.html', 'cover.html'];

function scanDir(root: string, source: 'bundled' | 'user'): ThemeInfo[] {
  let entries: string[];
  try { entries = readdirSync(root); }
  catch { return []; }
  const out: ThemeInfo[] = [];
  for (const name of entries) {
    const abs = resolve(root, name);
    if (!isThemeDir(abs)) continue;
    out.push(readTheme(abs, name, source));
  }
  return out;
}

function isThemeDir(p: string): boolean {
  try {
    const s = statSync(p);
    if (!s.isDirectory()) return false;
    // Require at least one recognised template file
    return RECOGNISED.some(f => existsSync(resolve(p, f)));
  } catch { return false; }
}

function readTheme(dir: string, name: string, source: 'bundled' | 'user'): ThemeInfo {
  const files: Partial<Record<TemplateFormat, string>> = {};
  for (const f of RECOGNISED) {
    if (existsSync(resolve(dir, f))) files[f] = f;
  }
  return { name, dir, source, files };
}

/**
 * Structural sanity — catches the egregious malformed cases without trying to
 * parse LaTeX/HTML. The point is to fail fast with a message that names the
 * theme; pdflatex's own errors get the theme name prepended by the caller.
 */
function validateTemplate(themeName: string, filename: TemplateFormat, body: string, abs: string): void {
  const where = `template "${themeName}/${filename}" at ${abs}`;
  if (!body.trim()) {
    throw new Error(`${where} is empty.`);
  }
  if (filename.endsWith('.tex')) {
    if (!/\\documentclass\b/.test(body)) {
      throw new Error(`${where} is malformed — no \\documentclass found. A valid LaTeX template starts with e.g. \\documentclass[letterpaper,11pt]{article}.`);
    }
    const beginDoc = /\\begin\{document\}/.test(body);
    const endDoc   = /\\end\{document\}/.test(body);
    if (!beginDoc || !endDoc) {
      throw new Error(`${where} is malformed — missing ${!beginDoc ? '\\begin{document}' : ''}${!beginDoc && !endDoc ? ' and ' : ''}${!endDoc ? '\\end{document}' : ''}.`);
    }
  } else if (filename.endsWith('.html')) {
    // Light check — must look like HTML (have a body or html tag). We don't
    // demand a doctype because some authors omit it for fragments.
    if (!/<\s*(html|body)\b/i.test(body)) {
      throw new Error(`${where} is malformed — no <html> or <body> tag found.`);
    }
  }
}
