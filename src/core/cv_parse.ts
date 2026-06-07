// Parse cv.md into the structured pieces the HTML CV template expects.
// We keep this simple and resilient: section headers in cv.md drive what we extract.
// Anything we can't confidently extract falls back to an empty section so the renderer
// still produces a valid PDF.
import { loadProjectFiles, type Profile } from './profile.js';

export interface CVData {
  name:               string;
  phone:              string;
  email:              string;
  location:           string;
  linkedin_url:       string;
  linkedin_display:   string;
  portfolio_url:      string;
  portfolio_display:  string;
  summary:            string;
  competencies:       string[];
  experiences:        ExperienceItem[];
  projects:           ProjectItem[];
  education:          EducationItem[];
  certifications:     CertItem[];
  skills:             SkillCategory[];
}

export interface ExperienceItem {
  company:   string;
  period:    string;
  role:      string;
  location:  string;
  bullets:   string[];
}

export interface ProjectItem {
  title: string;
  badge: string | null;
  description: string;
  tech: string | null;
}

export interface EducationItem {
  title: string;
  org:   string;
  year:  string;
  desc:  string;
}

export interface CertItem { title: string; org: string; year: string; }
export interface SkillCategory { category: string; items: string; }

const SECTION_HEADERS = [
  'professional summary',
  'work experience',
  'projects',
  'projects & open source',
  'education',
  'certifications',
  'skills',
];

export function parseCV(): CVData {
  const { cvMd, profile } = loadProjectFiles();
  const identity = identityFromProfile(profile);
  const empty: CVData = {
    ...identity,
    summary: '',
    competencies: [],
    experiences: [],
    projects: [],
    education: [],
    certifications: [],
    skills: [],
  };
  if (!cvMd) return empty;

  const sections = splitSections(cvMd);
  return {
    ...identity,
    summary:        parseSummary(sections),
    competencies:   parseCompetencies(profile),
    experiences:    parseExperiences(sections),
    projects:       parseProjects(sections),
    education:      parseEducation(sections),
    certifications: parseCertifications(sections),
    skills:         parseSkills(sections),
  };
}

// ── Identity (profile.yml wins; cv.md header fills gaps) ─────────────────────

function identityFromProfile(profile: Profile | null): Pick<
  CVData,
  'name' | 'phone' | 'email' | 'location' | 'linkedin_url' | 'linkedin_display' |
  'portfolio_url' | 'portfolio_display'
> {
  const c = profile?.candidate ?? {};
  const linkedin = c.linkedin ?? '';
  const portfolio = c.portfolio_url ?? c.github ?? '';
  return {
    name:              c.full_name ?? 'Candidate',
    phone:             c.phone ?? '',
    email:             c.email ?? '',
    location:          c.location ?? '',
    linkedin_url:      linkedin ? (linkedin.startsWith('http') ? linkedin : `https://${linkedin}`) : '',
    linkedin_display:  linkedin.replace(/^https?:\/\//, ''),
    portfolio_url:     portfolio ? (portfolio.startsWith('http') ? portfolio : `https://${portfolio}`) : '',
    portfolio_display: portfolio.replace(/^https?:\/\//, ''),
  };
}

// ── Section splitter ─────────────────────────────────────────────────────────

function splitSections(md: string): Map<string, string> {
  const m = new Map<string, string>();
  // Use ## headers as section boundaries; case-insensitive title matching.
  const re = /^##\s+(.+)$/gm;
  const indices: { name: string; start: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(md))) {
    indices.push({ name: match[1].trim().toLowerCase(), start: match.index + match[0].length });
  }
  for (let i = 0; i < indices.length; i++) {
    const end = i + 1 < indices.length ? indices[i + 1].start - (`## ${indices[i + 1].name}`.length + 1) : md.length;
    m.set(indices[i].name, md.slice(indices[i].start, end).trim());
  }
  return m;
}

function getSection(sections: Map<string, string>, ...names: string[]): string {
  for (const n of names) {
    const v = sections.get(n.toLowerCase());
    if (v) return v;
  }
  return '';
}

function parseSummary(sections: Map<string, string>): string {
  const body = getSection(sections, 'professional summary', 'summary');
  return body.replace(/\n+/g, ' ').trim();
}

function parseCompetencies(profile: Profile | null): string[] {
  const sp = (profile?.narrative as any)?.superpowers as string[] | undefined;
  if (Array.isArray(sp)) return sp.slice(0, 8);
  return [];
}

function parseExperiences(sections: Map<string, string>): ExperienceItem[] {
  const body = getSection(sections, 'work experience', 'experience');
  if (!body) return [];
  // Each ### header = one job. Pattern: "### Company — Role"; next line: period + optional location.
  const lines = body.split('\n');
  const out: ExperienceItem[] = [];
  let cur: ExperienceItem | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^###\s+(.+)$/);
    if (h) {
      if (cur) out.push(cur);
      const [company, role] = splitCompanyRole(h[1]);
      // Next non-empty NON-BULLET line is the "<period> · <location>" meta. Skipping
      // bullets matters when a role has no meta line (e.g. a sync-back round-trip) — we
      // must not consume the first bullet as the period.
      const next = lines.slice(i + 1).find(l => l.trim() !== '' && !/^\s*-\s+/.test(l)) ?? '';
      const { period, location } = splitPeriodLocation(next);
      cur = { company, role, period, location, bullets: [] };
      continue;
    }
    if (cur && /^\s*-\s+/.test(line)) {
      cur.bullets.push(line.replace(/^\s*-\s+/, '').trim());
    }
  }
  if (cur) out.push(cur);
  return out;
}

function splitCompanyRole(s: string): [string, string] {
  // Accepts em-dash, en-dash, hyphen, or pipe between Company and Role.
  const m = s.match(/^(.+?)\s+[—–\-|]\s+(.+)$/);
  return m ? [m[1].trim(), m[2].trim()] : [s.trim(), ''];
}

function splitPeriodLocation(s: string): { period: string; location: string } {
  // Examples we see: "Remote / India · Apr 2022 – Jan 2025"
  //                  "India · Sept 2021 – Apr 2022"
  // Some users use ` | ` instead of ` · `. Try both.
  const sep = s.includes('·') ? '·' : (s.includes('|') ? '|' : null);
  if (sep) {
    const parts = s.split(sep).map(p => p.trim());
    if (parts.length >= 2) {
      // Heuristic: whichever part looks like a date range is the period.
      const isPeriod = (t: string) => /\d{4}/.test(t) || /present/i.test(t);
      if (isPeriod(parts[0]) && !isPeriod(parts[1])) {
        return { period: parts[0], location: parts.slice(1).join(' / ') };
      }
      if (!isPeriod(parts[0]) && isPeriod(parts[1])) {
        return { period: parts[1], location: parts[0] };
      }
      return { period: parts.find(isPeriod) ?? parts[1], location: parts.find(p => !isPeriod(p)) ?? parts[0] };
    }
  }
  return { period: s.trim(), location: '' };
}

function parseProjects(sections: Map<string, string>): ProjectItem[] {
  const body = getSection(sections, 'projects & open source', 'projects');
  if (!body) return [];
  const items: ProjectItem[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^-\s+\*\*([^*]+)\*\*\s*(?:\(([^)]+)\))?\s*[—–-]\s*(.+)$/);
    if (!m) continue;
    items.push({
      title: m[1].trim(),
      badge: m[2]?.trim() ?? null,
      description: m[3].trim(),
      tech: null,
    });
  }
  return items;
}

function parseEducation(sections: Map<string, string>): EducationItem[] {
  const body = getSection(sections, 'education');
  if (!body) return [];
  const items: EducationItem[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^-\s+\*\*([^*]+)\*\*,?\s*(.*)$/);
    if (!m) continue;
    const title = m[1].trim();
    const rest  = m[2].trim();
    const yearMatch = rest.match(/(\d{4}(?:[\-–]\d{4})?)/);
    const year = yearMatch ? yearMatch[1] : '';
    // Remove the year, then clean up the empty parens it leaves behind ("(2020)" → "()"),
    // and a leading separator dash so the org isn't captured as an empty string. Both make
    // the packet ↔ cv.md round-trip (sync_packet_to_cv) preserve the institution.
    let restNoYear = (year ? rest.replace(year, '') : rest)
      .replace(/\(\s*\)/g, '')
      .replace(/^\s*[—–-]\s*/, '')
      .trim();
    const [org, ...descBits] = restNoYear.split('—').map(s => s.trim());
    items.push({ title, org: org ?? '', year, desc: descBits.join(' — ') });
  }
  return items;
}

function parseCertifications(_sections: Map<string, string>): CertItem[] {
  // Not present in this user's CV; return empty so the section renders blank.
  return [];
}

function parseSkills(sections: Map<string, string>): SkillCategory[] {
  const body = getSection(sections, 'skills');
  if (!body) return [];
  const cats: SkillCategory[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^-\s+\*\*([^*:]+):\*\*\s*(.+)$/);
    if (!m) continue;
    cats.push({ category: m[1].trim(), items: m[2].trim() });
  }
  return cats;
}
