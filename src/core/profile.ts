// Loads cv.md + config/profile.yml + portals.yml from the configured project root,
// and rebuilds the active career_packet from those files.
//
// The packet content is built from THREE inputs:
//   1. modes/career_packet.md — the structural template (sections, hard rules)
//   2. config/profile.yml      — identity → Section 1
//   3. cv.md                   — parsed via parseCV() → Sections 3-8 (work, projects,
//                                 skills, education) so the chat sees real bullets,
//                                 not <TODO> placeholders.
//
// The hard rule from the brief stays intact: NOTHING in the packet is invented; every
// bullet, project, skill, and degree comes verbatim from cv.md.

import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

import { config } from '../config.js';
import { getDb, runInWriteLock } from '../db.js';
import { parseCV, type CVData, type ExperienceItem, type ProjectItem, type EducationItem, type SkillCategory } from './cv_parse.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Profile {
  candidate: {
    full_name?:    string;
    email?:        string;
    phone?:        string;
    location?:     string;
    linkedin?:     string;
    portfolio_url?:string;
    github?:       string;
    twitter?:      string;
  };
  target_roles?: unknown;
  narrative?:    unknown;
  compensation?: unknown;
  location?:     unknown;
  cv?:           { output_format?: 'html' | 'latex' };
  language?:     { modes_dir?: string };
}

export interface ProjectFiles {
  cvMd:        string | null;
  profile:     Profile | null;
  portalsYml:  string | null;
}

// ── Loaders ──────────────────────────────────────────────────────────────────

export function pathInProject(...parts: string[]): string {
  return resolve(config.projectRoot, ...parts);
}

export function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

export function loadProjectFiles(): ProjectFiles {
  const cvMd       = readIfExists(pathInProject('cv.md'));
  const profileRaw = readIfExists(pathInProject('config', 'profile.yml'));
  const portalsYml = readIfExists(pathInProject('portals.yml'));

  let profile: Profile | null = null;
  if (profileRaw) {
    const parsed = yaml.load(profileRaw);
    if (parsed && typeof parsed === 'object') {
      profile = parsed as Profile;
    }
  }
  return { cvMd, profile, portalsYml };
}

// ── Staleness detection ──────────────────────────────────────────────────────

const TODO_MARKER = /<TODO[\s>]/g;
const MIN_REAL_CV_BYTES = 500;     // anything smaller is probably still the example

/** True when the packet body still has 3+ literal `<TODO ...>` markers (template-y). */
export function isPlaceholderPacket(content: string | null | undefined): boolean {
  if (!content) return true;
  return (content.match(TODO_MARKER) || []).length >= 3;
}

/** True when cv.md exists with non-trivial, non-example content. */
export function cvHasRealContent(cvMd: string | null | undefined): boolean {
  if (!cvMd) return false;
  if (cvMd.length < MIN_REAL_CV_BYTES) return false;
  // The example template has every bullet starting with `<...>` (placeholder).
  // A real CV has at least a few bullets that don't start with an angle bracket.
  const realBullets = (cvMd.match(/^[ \t]*-[ \t]+[^<\n]/gm) || []).length;
  return realBullets >= 3;
}

export type PacketStatus =
  | 'ok'                        // packet matches the current cv.md
  | 'no_packet'                 // DB has no active row
  | 'no_cv'                     // cv.md missing
  | 'cv_is_example'             // cv.md present but still the <…> example template
  | 'cv_edited_since_seed'      // cv.md hash differs from packet.source_cv_hash → reseed needed
  | 'packet_is_template';       // packet still has TODO markers in its body

export function packetStatus(args: {
  active: { content: string; source_cv_hash: string | null } | null;
  cvMd:   string | null;
}): PacketStatus {
  if (!args.active) return 'no_packet';
  if (!args.cvMd)   return 'no_cv';
  if (!cvHasRealContent(args.cvMd)) return 'cv_is_example';
  // cv has real content — now check it matches what we built the packet from.
  if (args.active.source_cv_hash && sha256(args.cvMd) !== args.active.source_cv_hash) {
    return 'cv_edited_since_seed';
  }
  if (isPlaceholderPacket(args.active.content)) return 'packet_is_template';
  return 'ok';
}

// ── Active-packet accessor ──────────────────────────────────────────────────

export function getActiveCareerPacket(): {
  id: string; version: number; content: string; source_cv_hash: string | null;
} | null {
  const row = getDb()
    .prepare(`SELECT id, version, content, source_cv_hash FROM career_packet WHERE is_active = 1`)
    .get() as any;
  return row ?? null;
}

// ── Seed / reseed ────────────────────────────────────────────────────────────

export interface SeedResult {
  version:        number;
  created:        boolean;            // true = wrote a new row, false = no change
  reused:         boolean;            // true when ensureActive saw existing row + force=false
  bytes:          number;
  sections_with_cv_content: number;  // 0..6 — how many of S3-S8 got real cv.md content
  preview:        string;             // first ~400 chars for confirmation
}

/**
 * Rebuild the active career packet from cv.md + profile.yml using the template at
 * modes/career_packet.md. Always writes a NEW row (bumps version, demotes previous)
 * unless `mode: 'ensure_active'` and an active row already exists.
 *
 *   mode='reseed'        — always writes a new version. The default.
 *   mode='ensure_active' — only seeds if no active row exists (used by first-run boot).
 */
export async function seedCareerPacketFromFiles(opts: { mode?: 'reseed' | 'ensure_active' } = {}): Promise<SeedResult> {
  const mode = opts.mode ?? 'reseed';
  const db = getDb();

  if (mode === 'ensure_active') {
    const existing = db.prepare(`SELECT version, content FROM career_packet WHERE is_active = 1`).get() as
      { version: number; content: string } | undefined;
    if (existing) {
      return {
        version: existing.version, created: false, reused: true,
        bytes: existing.content.length, sections_with_cv_content: countSectionsWithCvContent(existing.content),
        preview: existing.content.slice(0, 400),
      };
    }
  }

  const { content, sectionsWithContent, cvHash } = buildPacketContent();
  const id = randomUUID();

  const result = await runInWriteLock(() => {
    const lastV = (db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM career_packet`).get() as any).v as number;
    const newV = lastV + 1;
    db.prepare(`UPDATE career_packet SET is_active = 0 WHERE is_active = 1`).run();
    db.prepare(`
      INSERT INTO career_packet (id, version, content, taglines, is_active, source_cv_hash, notes)
      VALUES (?, ?, ?, NULL, 1, ?, ?)
    `).run(id, newV, content, cvHash, mode === 'ensure_active' ? 'seeded on first run' : 'reseeded from cv.md + profile.yml');
    return { version: newV };
  });

  return {
    version: result.version, created: true, reused: false,
    bytes: content.length, sections_with_cv_content: sectionsWithContent,
    preview: content.slice(0, 400),
  };
}

/** Back-compat thin wrapper around seedCareerPacketFromFiles for boot-time callers. */
export async function ensureActiveCareerPacket(): Promise<{ version: number; created: boolean }> {
  const r = await seedCareerPacketFromFiles({ mode: 'ensure_active' });
  return { version: r.version, created: r.created };
}

// ── Packet building ─────────────────────────────────────────────────────────

interface BuildResult {
  content: string;
  sectionsWithContent: number;
  cvHash: string | null;
}

function buildPacketContent(): BuildResult {
  const { cvMd, profile } = loadProjectFiles();
  const templatePath = resolve(config.modesDir, 'career_packet.md');
  let content = readIfExists(templatePath) ?? '# Career Packet (empty template)';

  // Always inject identity from profile.yml into Section 1.
  content = replaceSectionBody(content, '1.', renderIdentityBlock(profile));

  let sectionsWithContent = 0;
  if (cvMd) {
    const cv = parseCV();   // parseCV reads cv.md via loadProjectFiles() internally

    // Sections 3, 4, 5 — experience bullet banks. The template ships three: most recent,
    // previous, earlier. If cv.md has more roles, fold the extras into Section 5.
    const exp = cv.experiences;
    if (exp[0]) {
      content = replaceSectionBody(content, '3.', renderRoleSection(exp[0])); sectionsWithContent++;
    }
    if (exp[1]) {
      content = replaceSectionBody(content, '4.', renderRoleSection(exp[1])); sectionsWithContent++;
    }
    if (exp.slice(2).length) {
      content = replaceSectionBody(content, '5.', exp.slice(2).map(renderRoleSection).join('\n\n')); sectionsWithContent++;
    }

    // Section 6 — projects bank.
    if (cv.projects.length) {
      content = replaceSectionBody(content, '6.', renderProjectsBank(cv.projects)); sectionsWithContent++;
    }
    // Section 7 — skills bank.
    if (cv.skills.length) {
      content = replaceSectionBody(content, '7.', renderSkillsBank(cv.skills)); sectionsWithContent++;
    }
    // Section 8 — education.
    if (cv.education.length) {
      content = replaceSectionBody(content, '8.', renderEducationBank(cv.education)); sectionsWithContent++;
    }
  }

  return {
    content,
    sectionsWithContent,
    cvHash: cvMd ? sha256(cvMd) : null,
  };
}

function countSectionsWithCvContent(content: string): number {
  // Heuristic: count Sections 3-8 whose body still contains a <TODO marker (meaning NOT
  // populated from cv.md). Real sections = 6 - count(TODO sections).
  const sections = splitNumberedSections(content);
  let withContent = 0;
  for (const n of ['3.', '4.', '5.', '6.', '7.', '8.']) {
    const body = sections.get(n) ?? '';
    if (body && !TODO_MARKER.test(body)) withContent++;
    TODO_MARKER.lastIndex = 0;   // reset global regex
  }
  return withContent;
}

// ── Section parsing + rewriting ─────────────────────────────────────────────

/** Replace the body of `## N. ...` (keep the heading line) with newBody. */
function replaceSectionBody(content: string, prefix: string, newBody: string): string {
  // Match the heading line (## N. ...) and capture everything after it until the next
  // `## ` heading or end-of-document. We anchor the prefix to start-of-line.
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^## ${escaped}[^\\n]*\\n)([\\s\\S]*?)(?=^## |\\z)`, 'm');
  if (!re.test(content)) return content;        // section not in template — leave content alone
  return content.replace(re, (_match, heading) => `${heading}\n${newBody.trim()}\n\n`);
}

function splitNumberedSections(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^## (\d+\.)[^\n]*$/gm;
  const matches: { prefix: string; start: number; end: number }[] = [];
  let m;
  while ((m = re.exec(content))) {
    matches.push({ prefix: m[1], start: m.index + m[0].length, end: -1 });
  }
  for (let i = 0; i < matches.length; i++) {
    matches[i].end = i + 1 < matches.length ? matches[i + 1].start - (`## ${matches[i + 1].prefix}`.length + 1) : content.length;
    out.set(matches[i].prefix, content.slice(matches[i].start, matches[i].end).trim());
  }
  return out;
}

// ── Renderers ───────────────────────────────────────────────────────────────

function renderIdentityBlock(profile: Profile | null): string {
  if (!profile?.candidate) return '_No `config/profile.yml` found — populate it to enrich._';
  const c = profile.candidate;
  const lines: string[] = [];
  if (c.full_name)    lines.push(`- **Name:** ${c.full_name}`);
  if (c.email)        lines.push(`- **Email:** ${c.email}`);
  if (c.phone)        lines.push(`- **Phone:** ${c.phone}`);
  if (c.location)     lines.push(`- **Location:** ${c.location}`);
  if (c.linkedin)     lines.push(`- **LinkedIn:** ${c.linkedin}`);
  if (c.portfolio_url)lines.push(`- **Portfolio:** ${c.portfolio_url}`);
  if (c.github)       lines.push(`- **GitHub:** ${c.github}`);
  if (c.twitter)      lines.push(`- **Twitter:** ${c.twitter}`);
  return lines.length ? lines.join('\n') : '_Profile present but no candidate fields filled._';
}

function renderRoleSection(exp: ExperienceItem): string {
  const meta = [exp.location, exp.period].filter(Boolean).join(' · ');
  const head = `**${exp.company}** — ${exp.role}` + (meta ? `  \n_${meta}_` : '');
  const bullets = exp.bullets.length
    ? exp.bullets.map(b => `- ${b}`).join('\n')
    : '- _(no bullets in cv.md for this role)_';
  return `${head}\n\n${bullets}`;
}

function renderProjectsBank(projects: ProjectItem[]): string {
  return projects.map(p => {
    const badge = p.badge ? ` (${p.badge})` : '';
    const tech  = p.tech  ? `  \n  _${p.tech}_` : '';
    return `- **${p.title}**${badge} — ${p.description}${tech}`;
  }).join('\n');
}

function renderSkillsBank(skills: SkillCategory[]): string {
  return skills.map(s => `- **${s.category}:** ${s.items}`).join('\n');
}

function renderEducationBank(edus: EducationItem[]): string {
  return edus.map(e => {
    const year = e.year ? ` (${e.year})` : '';
    const desc = e.desc ? `. ${e.desc}` : '';
    const orgPart = e.org ? ` — ${e.org}` : '';
    return `- **${e.title}**${orgPart}${year}${desc}`;
  }).join('\n');
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

// Used by callers (CLI doctor, MCP tool) — preview = first ~400 chars of the active packet.
export function packetPreview(content: string, max = 400): string {
  const trimmed = content.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max) + '\n…';
}
