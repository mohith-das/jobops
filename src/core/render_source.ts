// Render-time content source for resume/cover generation across all formats.
//
// Every render must reflect what is current RIGHT NOW:
//   1. cv.md + profile.yml         — the base (parseCV, read fresh per render)
//   2. the active career_packet    — when it is chat-edited (origin='chat_edit'),
//      its Sections 3–8 are intentionally ahead of cv.md and win per section
//   3. applications.tailored_bullets — the job's persisted materials (latest
//      materials_v) overlay the matched experiences / projects / skills / tagline
//
// Renderers must NOT cache any of this; cvForRender() re-reads files and the DB
// on every call so a packet edit or a generate_materials persist between two
// renders changes the output.
//
// Tailored content arrives in the tailoring_rules.md contract: bullets may be
// `\resumeItem{...}`-wrapped LaTeX with `\textbf{...}` emphasis and escaped
// specials. We normalize that to the plain cv.md grammar (`**bold**`, raw
// specials) so each renderer applies its own escaping exactly once.

import { getDb } from '../db.js';
import { parseCV, parseCVText, type CVData, type ExperienceItem, type ProjectItem, type SkillCategory } from './cv_parse.js';
import { getActiveCareerPacket, cvMarkdownFromPacket, loadProjectFiles, type Profile } from './profile.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Shape of applications.tailored_bullets as persisted by generate_materials. */
export interface TailoredMaterials {
  tagline?:            string | null;
  experience_bullets?: Record<string, string[]> | null;
  projects_section?:   string | null;
  skills_section?:     string | null;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Build the CVData a render should use, current as of THIS call.
 * With a job_id, the application's tailored materials overlay the base content;
 * without one, you still get the freshest cv.md/packet state.
 */
export function cvForRender(job_id?: string): CVData {
  let cv = parseCV();
  const active = getActiveCareerPacket();
  if (active?.origin === 'chat_edit') {
    // Chat-edited packets are intentionally ahead of cv.md (see packetStatus) —
    // their content banks are the current truth for renders.
    const { profile } = loadProjectFiles();
    cv = overlayPacketSections(cv, active.content, profile);
  }
  if (job_id) {
    const materials = loadTailoredMaterials(job_id);
    if (materials) cv = applyTailoredOverlay(cv, materials);
  }
  return cv;
}

/** Read the job's persisted materials off the application row. Null when absent/unparseable. */
export function loadTailoredMaterials(job_id: string): TailoredMaterials | null {
  const row = getDb()
    .prepare(`SELECT tailored_bullets FROM applications WHERE job_id = ?`)
    .get(job_id) as { tailored_bullets: string | null } | undefined;
  if (!row?.tailored_bullets) return null;
  try {
    const parsed = JSON.parse(row.tailored_bullets);
    return parsed && typeof parsed === 'object' ? (parsed as TailoredMaterials) : null;
  } catch {
    return null;
  }
}

// ── Packet overlay ───────────────────────────────────────────────────────────

/**
 * Replace the base content banks with the packet's Sections 3–8, per section:
 * a section the packet doesn't fill (or that doesn't parse) keeps the cv.md
 * version. Identity and summary stay with the base — the packet has no summary
 * section and identity always comes from profile.yml.
 */
export function overlayPacketSections(base: CVData, packetContent: string, profile: Profile | null): CVData {
  const { markdown } = cvMarkdownFromPacket(packetContent, profile);
  const fromPacket = parseCVText(markdown, profile);
  return {
    ...base,
    experiences: fromPacket.experiences.length ? fromPacket.experiences : base.experiences,
    projects:    fromPacket.projects.length    ? fromPacket.projects    : base.projects,
    education:   fromPacket.education.length   ? fromPacket.education   : base.education,
    skills:      fromPacket.skills.length      ? fromPacket.skills      : base.skills,
  };
}

// ── Tailored-materials overlay ───────────────────────────────────────────────

/**
 * Overlay one application's tailored materials onto the base CVData.
 * Hard rule preserved: nothing is invented — an experience slug that matches no
 * role in the base content is dropped, and a projects/skills section that
 * doesn't parse falls back to the base section.
 */
export function applyTailoredOverlay(base: CVData, m: TailoredMaterials): CVData {
  const cv: CVData = {
    ...base,
    experiences: base.experiences.map(e => ({ ...e, bullets: [...e.bullets] })),
  };

  if (typeof m.tagline === 'string' && m.tagline.trim()) {
    cv.summary = normalizeTailoredText(m.tagline);
  }

  if (m.experience_bullets && typeof m.experience_bullets === 'object') {
    for (const [slug, bullets] of Object.entries(m.experience_bullets)) {
      if (!Array.isArray(bullets) || !bullets.length) continue;
      const idx = matchExperienceSlug(cv.experiences, slug);
      if (idx === -1) continue;
      const normalized = bullets
        .filter((b): b is string => typeof b === 'string')
        .map(normalizeTailoredText)
        .filter(Boolean);
      if (normalized.length) cv.experiences[idx] = { ...cv.experiences[idx], bullets: normalized };
    }
  }

  if (typeof m.projects_section === 'string' && m.projects_section.trim()) {
    const projects = parseTailoredProjects(m.projects_section);
    if (projects.length) cv.projects = projects;
  }
  if (typeof m.skills_section === 'string' && m.skills_section.trim()) {
    const skills = parseTailoredSkills(m.skills_section);
    if (skills.length) cv.skills = skills;
  }
  return cv;
}

/**
 * Map an experience_bullets slug to an index in `experiences`, or -1.
 * Accepts the ordinal slugs tailoring_rules.md suggests (current_role,
 * previous_role, earlier_roles) and employer/role name slugs (e.g. "vellum",
 * "mosaic_senior_analyst").
 */
export function matchExperienceSlug(experiences: ExperienceItem[], slug: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const s = norm(slug);
  if (!s) return -1;

  if (/^(current|most recent|latest)( role)?$/.test(s)) return experiences.length > 0 ? 0 : -1;
  if (/^(previous|prior)( role)?$/.test(s))             return experiences.length > 1 ? 1 : -1;
  if (/^earlier( roles?)?$/.test(s))                    return experiences.length > 2 ? 2 : -1;

  for (let i = 0; i < experiences.length; i++) {
    const company = norm(experiences[i].company);
    const role    = norm(experiences[i].role);
    if (company && (company.includes(s) || s.includes(company))) return i;
    if (role && (role.includes(s) || s.includes(role))) return i;
    // Token subset: every slug token appears somewhere in "company role".
    const haystack = new Set(`${company} ${role}`.split(' ').filter(Boolean));
    const tokens = s.split(' ').filter(Boolean);
    if (tokens.length && tokens.every(t => haystack.has(t))) return i;
  }
  return -1;
}

// ── Tailored-section parsing (markdown bank grammar OR the LaTeX contract) ───

/**
 * Parse a tailored projects_section. Tries the packet's markdown bank grammar
 * first (`- **Title** (badge) — description`); falls back to a best-effort read
 * of the tailoring_rules.md LaTeX contract (`\resumeProjectHeading` blocks).
 * Empty result means "keep the base projects".
 */
export function parseTailoredProjects(section: string): ProjectItem[] {
  const items: ProjectItem[] = [];
  for (const raw of section.split('\n')) {
    const line = normalizeTailoredText(raw);
    const m = line.match(/^-\s+\*\*([^*]+)\*\*\s*(?:\(([^)]+)\))?\s*[—–-]+\s*(.+)$/);
    if (m) items.push({ title: m[1].trim(), badge: m[2]?.trim() ?? null, description: m[3].trim(), tech: null });
  }
  if (items.length) return items;

  for (const chunk of section.split(/\\resumeProjectHeading/).slice(1)) {
    const title = chunk.match(/\\textbf\{([^{}]+)\}/);
    if (!title) continue;
    // Heading text after the title, up to the `$|$ \href{…}` link or the closing
    // brace of the heading argument — keep the human-readable description only.
    const headLine = chunk.slice((title.index ?? 0) + title[0].length)
      .split('\n')[0]
      .replace(/\$\|\$[\s\S]*$/, '')
      .replace(/\}[\s\S]*$/, '')
      .replace(/^[\s—–-]+/, '')
      .trim();
    // Bullet bodies may nest one brace level (`\textbf{…}` inside the argument).
    const bullets = [...chunk.matchAll(/\\resumeItem\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map(x => normalizeTailoredText(x[1]));
    const description = [normalizeTailoredText(headLine), bullets.join(' ')].filter(Boolean).join(' — ');
    if (description) items.push({ title: normalizeTailoredText(title[1]), badge: null, description, tech: null });
  }
  return items;
}

/**
 * Parse a tailored skills_section: packet bank lines (`- **Cat:** items`) or
 * the LaTeX contract (`\item \textbf{Cat:} items`). Empty result means "keep
 * the base skills".
 */
export function parseTailoredSkills(section: string): SkillCategory[] {
  const out: SkillCategory[] = [];
  for (const raw of section.split('\n')) {
    const line = normalizeTailoredText(raw).replace(/^-\s+/, '');
    const m = line.match(/^\*\*(.+?)\*\*:?\s*(.+)$/);
    if (m) out.push({ category: m[1].trim().replace(/:$/, ''), items: m[2].trim() });
  }
  return out;
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Bring one tailored string back to the plain cv.md grammar: strip the
 * `\resumeItem{…}` wrapper and `\item ` prefix, `\textbf{…}` → `**…**`, and
 * un-escape LaTeX specials so the renderers' own escaping doesn't double up.
 */
export function normalizeTailoredText(s: string): string {
  let t = String(s).trim();
  const wrapped = t.match(/^\\resumeItem\{([\s\S]*)\}$/);
  if (wrapped) t = wrapped[1].trim();
  t = t.replace(/^\\item\s+/, '');
  t = t.replace(/\\textbf\{([^{}]*)\}/g, '**$1**');
  t = t.replace(/\\(?:emph|textit)\{([^{}]*)\}/g, '$1');
  t = t.replace(/\\([&%$#_])/g, '$1');
  return t.trim();
}
