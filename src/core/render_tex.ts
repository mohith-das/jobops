// LaTeX source generator for resume + cover letter.
//
// Builds self-contained .tex from the render-time content (cvForRender — cv.md
// plus the active packet and the job's tailored materials, read fresh per call)
// by rendering each section block to a LaTeX string, then substituting those
// blocks into a chosen theme template (see core/templates.ts). The default theme keeps
// the original Computer-Modern, ATS-clean look — compatible with vanilla
// pdflatex on any TeX Live install (no fontspec, no minted, no exotic packages).
//
// scanForVisaLeakage() must be called on the returned string by the caller
// before writing to disk; the rail applies to every output format.

import { type CVData, type ExperienceItem, type ProjectItem, type EducationItem, type SkillCategory } from './cv_parse.js';
import { cvForRender } from './render_source.js';
import { loadTemplate, fillTemplate, effectiveDefaultTemplate } from './templates.js';

// ── Public API ──────────────────────────────────────────────────────────────

export interface CoverFields {
  /** Plain prose cover body (250–350 words). Paragraph-broken on blank lines. */
  body:     string;
  /** Company name as it should appear under the date. */
  company:  string;
  /** Optional company location appended after the company name. */
  location: string;
}

export interface BuildTexOpts {
  /** Theme name. Defaults to JOBOPS_DEFAULT_TEMPLATE or "default". */
  theme?:  string;
  /** Overlay this job's persisted tailored materials onto the content. */
  job_id?: string;
  /** Pre-computed content (wins over job_id) — lets one tool call share one snapshot across formats. */
  cv?:     CVData;
}

/** Build the resume .tex from the current content (cv.md/packet + the job's materials). */
export function buildResumeTex(opts: BuildTexOpts = {}): string {
  const theme = opts.theme ?? effectiveDefaultTemplate();
  try {
    const cv  = opts.cv ?? cvForRender(opts.job_id);
    const tpl = loadTemplate(theme, 'resume.tex');
    return fillTemplate(tpl.body, resumeValues(cv), { comments: 'latex' });
  } catch (err: any) {
    // Wrap any downstream error with the theme name so it isn't cryptic.
    throw new Error(`render_tex (theme="${theme}"): ${err?.message ?? err}`);
  }
}

/** Build the cover .tex. `theme` defaults to JOBOPS_DEFAULT_TEMPLATE or "default". */
export function buildCoverTex(args: CoverFields, opts: BuildTexOpts = {}): string {
  const theme = opts.theme ?? effectiveDefaultTemplate();
  try {
    const cv  = opts.cv ?? cvForRender(opts.job_id);
    const tpl = loadTemplate(theme, 'cover.tex');
    return fillTemplate(tpl.body, coverValues(cv, args), { comments: 'latex' });
  } catch (err: any) {
    throw new Error(`render_tex cover (theme="${theme}"): ${err?.message ?? err}`);
  }
}

// ── Placeholder values: resume ──────────────────────────────────────────────

function resumeValues(cv: CVData): Record<string, string> {
  return {
    HEADER:                  header(cv),
    SUMMARY_SECTION:         section('Summary',         cv.summary?.trim() ? escapeLatex(cv.summary.trim()) : ''),
    SKILLS_SECTION:          section('Skills',          cv.skills?.length ? skillsSection(cv.skills) : ''),
    EXPERIENCE_SECTION:      section('Experience',      cv.experiences?.length ? cv.experiences.map(experienceBlock).join('\n') : ''),
    PROJECTS_SECTION:        section('Projects',        cv.projects?.length ? cv.projects.map(projectBlock).join('\n') : ''),
    EDUCATION_SECTION:       section('Education',       cv.education?.length ? cv.education.map(educationBlock).join('\n') : ''),
    CERTIFICATIONS_SECTION:  '',  // not surfaced from cv.md/profile.yml at this layer; user templates can hard-code or skip
  };
}

/** Produce \section*{title}\n<body> or empty if body is empty. */
function section(title: string, body: string): string {
  if (!body) return '';
  return `\\section*{${title}}\n${body}\n`;
}

function header(cv: CVData): string {
  const contact: string[] = [];
  if (cv.location)      contact.push(escapeLatex(cv.location));
  if (cv.email)         contact.push(escapeLatex(cv.email));
  if (cv.phone)         contact.push(escapeLatex(cv.phone));
  const links: string[] = [];
  if (cv.linkedin_url)  links.push(`\\href{${escapeUrl(cv.linkedin_url)}}{${escapeLatex(cv.linkedin_display || cv.linkedin_url)}}`);
  if (cv.portfolio_url) links.push(`\\href{${escapeUrl(cv.portfolio_url)}}{${escapeLatex(cv.portfolio_display || cv.portfolio_url)}}`);

  const lines: string[] = [];
  lines.push(`{\\huge\\bfseries ${escapeLatex(cv.name || 'Candidate')}}`);
  if (contact.length) lines.push(`\\\\[2pt]\n{\\small ${contact.join(' \\quad ')}}`);
  if (links.length)   lines.push(`\\\\[1pt]\n{\\small ${links.join(' \\quad ')}}`);
  return lines.join('\n');
}

function skillsSection(skills: SkillCategory[]): string {
  return skills.map(s => `\\textbf{${escapeLatex(s.category)}:} ${escapeLatex(s.items)}\\\\`).join('\n');
}

function experienceBlock(e: ExperienceItem): string {
  const right = e.period ? `\\hfill {\\small\\itshape ${escapeLatex(e.period)}}` : '';
  const meta  = [e.role, e.location].filter(Boolean).map(escapeLatex).join(' \\textemdash{} ');
  const out: string[] = [];
  out.push(`\\textbf{${escapeLatex(e.company)}} ${right}`);
  if (meta) out.push(`\\\\\n{\\small ${meta}}`);
  if (e.bullets?.length) {
    out.push('');
    out.push('\\begin{itemize}');
    for (const b of e.bullets) out.push(`  \\item ${escapeLatex(b)}`);
    out.push('\\end{itemize}');
  }
  out.push('');
  return out.join('\n');
}

function projectBlock(p: ProjectItem): string {
  const badge = p.badge ? ` {\\small(${escapeLatex(p.badge)})}` : '';
  const tech  = p.tech  ? `\\\\\n{\\footnotesize\\textit{${escapeLatex(p.tech)}}}` : '';
  return `\\textbf{${escapeLatex(p.title)}}${badge} \\textemdash{} ${escapeLatex(p.description)}${tech}\\\\[2pt]`;
}

function educationBlock(e: EducationItem): string {
  const year = e.year ? ` \\hfill {\\small\\itshape ${escapeLatex(e.year)}}` : '';
  const org  = e.org  ? `, ${escapeLatex(e.org)}` : '';
  const desc = e.desc ? `\\\\\n{\\small ${escapeLatex(e.desc)}}` : '';
  return `\\textbf{${escapeLatex(e.title)}}${org}${year}${desc}\\\\[2pt]`;
}

// ── Placeholder values: cover ───────────────────────────────────────────────

function coverValues(cv: CVData, args: CoverFields): Record<string, string> {
  const paras = args.body
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(escapeLatex);

  const contact: string[] = [];
  if (cv.location) contact.push(escapeLatex(cv.location));
  if (cv.email)    contact.push(escapeLatex(cv.email));
  if (cv.phone)    contact.push(escapeLatex(cv.phone));

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const companyLine = [args.company, args.location].filter(Boolean).join(', ');

  // HEADER: name + contact line
  const headerLines: string[] = [];
  headerLines.push(`{\\large\\bfseries ${escapeLatex(cv.name || 'Candidate')}}\\\\`);
  if (contact.length) headerLines.push(`{\\small ${contact.join(' \\quad ')}}`);

  // ADDRESS: "Hiring Team\\Company, Location"
  const addressLines: string[] = ['Hiring Team\\\\'];
  addressLines.push(escapeLatex(companyLine || args.company || 'Hiring Team'));

  // SIGNATURE: "Best regards,\\Name"
  const signature = `Best regards,\\\\\n${escapeLatex(cv.name || 'Candidate')}`;

  return {
    HEADER:    headerLines.join('\n'),
    DATE:      escapeLatex(today),
    ADDRESS:   addressLines.join('\n'),
    GREETING:  'Dear Hiring Manager,',
    BODY:      paras.join('\n\n'),
    SIGNATURE: signature,
  };
}

// ── LaTeX escaping ──────────────────────────────────────────────────────────

const LATEX_SPECIALS: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&':  '\\&',
  '%':  '\\%',
  '$':  '\\$',
  '#':  '\\#',
  '_':  '\\_',
  '{':  '\\{',
  '}':  '\\}',
  '~':  '\\textasciitilde{}',
  '^':  '\\textasciicircum{}',
};

const SPECIAL_RE = /[\\&%$#_{}~^]/g;

/** Escape every LaTeX special. Order matters: \ must be first or it double-escapes. */
export function escapeLatex(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(SPECIAL_RE, ch => LATEX_SPECIALS[ch] ?? ch);
}

/** URL escaping for \href — only escape #, %, & (which are URL-safe but LaTeX-special). */
function escapeUrl(u: string): string {
  return u.replace(/[%#&]/g, ch => '\\' + ch);
}
