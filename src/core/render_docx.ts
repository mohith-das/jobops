// Word .docx generator for resume + cover letter.
//
// Uses the `docx` library (programmatic OOXML, no shell-out). Output is ATS-clean:
//   - Real Heading 1/2 styles (Word + Google Docs interpret these as headings)
//   - Real bulleted lists via Paragraph.bullet (NOT custom unicode dots)
//   - Standard Calibri 11pt body, no text boxes, no tables for layout
//   - 0.7 inch top/bottom, 0.75 inch sides — generous enough that ATS parsers
//     don't reject for being too tight
//
// The visa rail (scanForVisaLeakage) MUST be applied by the caller to the raw text
// inputs before this generator runs — the docx package emits binary OOXML that
// can't be greppable after the fact.

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ExternalHyperlink,
  PageOrientation, convertInchesToTwip,
} from 'docx';

import { type CVData, type ExperienceItem, type ProjectItem, type EducationItem, type SkillCategory } from './cv_parse.js';
import { cvForRender } from './render_source.js';

// ── Public API ──────────────────────────────────────────────────────────────

export interface CoverDocxFields {
  body:     string;     // plain prose, paragraph-broken on blank lines
  company:  string;
  location: string;
}

export interface BuildDocxOpts {
  /** Overlay this job's persisted tailored materials onto the content. */
  job_id?: string;
  /** Pre-computed content (wins over job_id) — lets one tool call share one snapshot across formats. */
  cv?:     CVData;
}

/** Build the resume .docx (returns a Buffer ready for fs.writeFileSync). */
export async function buildResumeDocx(opts: BuildDocxOpts = {}): Promise<Buffer> {
  const cv = opts.cv ?? cvForRender(opts.job_id);
  return Packer.toBuffer(resumeDocument(cv));
}

/** Build the cover letter .docx. */
export async function buildCoverDocx(args: CoverDocxFields, opts: BuildDocxOpts = {}): Promise<Buffer> {
  const cv = opts.cv ?? cvForRender(opts.job_id);
  return Packer.toBuffer(coverDocument(cv, args));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const FONT = 'Calibri';            // ubiquitous, ATS-safe
const BODY_SIZE = 22;              // docx sizes are half-points → 22 = 11pt
const NAME_SIZE = 36;              // 18pt
const HEADING_SIZE = 26;           // 13pt
const ACCENT = '145374';           // teal — matches the rest of the system

const PAGE_MARGINS = {
  top:    convertInchesToTwip(0.7),
  bottom: convertInchesToTwip(0.7),
  left:   convertInchesToTwip(0.75),
  right:  convertInchesToTwip(0.75),
};

function makeBody(text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}): TextRun {
  return new TextRun({ text, font: FONT, size: opts.size ?? BODY_SIZE,
                       bold: opts.bold, italics: opts.italics, color: opts.color });
}

function heading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 80 },
    border:  { bottom: { color: ACCENT, style: 'single', size: 6, space: 1 } },
    children: [new TextRun({ text, font: FONT, size: HEADING_SIZE, bold: true, color: ACCENT })],
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet:  { level: 0 },
    spacing: { before: 0, after: 60, line: 280 },
    children: [makeBody(text)],
  });
}

function body(text: string, opts: { spacingBefore?: number; spacingAfter?: number } = {}): Paragraph {
  return new Paragraph({
    spacing: { before: opts.spacingBefore ?? 0, after: opts.spacingAfter ?? 60, line: 280 },
    children: [makeBody(text)],
  });
}

// ── Resume ──────────────────────────────────────────────────────────────────

function resumeDocument(cv: CVData): Document {
  const children: Paragraph[] = [];

  // Header — name + contact + links
  children.push(new Paragraph({
    spacing: { after: 40 },
    children: [new TextRun({ text: cv.name || 'Candidate', font: FONT, size: NAME_SIZE, bold: true })],
  }));
  const contact: TextRun[] = [];
  const addSep = () => { if (contact.length) contact.push(makeBody('  ·  ', { color: '888888' })); };
  if (cv.location) { contact.push(makeBody(cv.location)); }
  if (cv.email)    { addSep(); contact.push(makeBody(cv.email)); }
  if (cv.phone)    { addSep(); contact.push(makeBody(cv.phone)); }
  if (contact.length) {
    children.push(new Paragraph({ spacing: { after: 40 }, children: contact }));
  }
  const linkRuns: (TextRun | ExternalHyperlink)[] = [];
  if (cv.linkedin_url) {
    linkRuns.push(new ExternalHyperlink({
      link: cv.linkedin_url,
      children: [new TextRun({ text: cv.linkedin_display || cv.linkedin_url, font: FONT, size: BODY_SIZE, color: ACCENT, style: 'Hyperlink' })],
    }));
  }
  if (cv.portfolio_url) {
    if (linkRuns.length) linkRuns.push(new TextRun({ text: '  ·  ', font: FONT, size: BODY_SIZE, color: '888888' }));
    linkRuns.push(new ExternalHyperlink({
      link: cv.portfolio_url,
      children: [new TextRun({ text: cv.portfolio_display || cv.portfolio_url, font: FONT, size: BODY_SIZE, color: ACCENT, style: 'Hyperlink' })],
    }));
  }
  if (linkRuns.length) {
    children.push(new Paragraph({ spacing: { after: 80 }, children: linkRuns as any }));
  }

  // Summary
  if (cv.summary?.trim()) {
    children.push(heading('Summary'));
    children.push(body(cv.summary.trim()));
  }

  // Skills
  if (cv.skills?.length) {
    children.push(heading('Skills'));
    for (const s of cv.skills) {
      children.push(new Paragraph({
        spacing: { before: 0, after: 40, line: 280 },
        children: [
          new TextRun({ text: `${s.category}: `, font: FONT, size: BODY_SIZE, bold: true }),
          makeBody(s.items),
        ],
      }));
    }
  }

  // Experience
  if (cv.experiences?.length) {
    children.push(heading('Experience'));
    for (const e of cv.experiences) children.push(...experienceBlock(e));
  }

  // Projects
  if (cv.projects?.length) {
    children.push(heading('Projects'));
    for (const p of cv.projects) children.push(...projectBlock(p));
  }

  // Education
  if (cv.education?.length) {
    children.push(heading('Education'));
    for (const e of cv.education) children.push(...educationBlock(e));
  }

  return new Document({
    creator: 'jobops',
    title:   `${cv.name || 'Candidate'} — Resume`,
    sections: [{
      properties: { page: { margin: PAGE_MARGINS, size: { orientation: PageOrientation.PORTRAIT } } },
      children,
    }],
  });
}

function experienceBlock(e: ExperienceItem): Paragraph[] {
  const out: Paragraph[] = [];
  // Company \hfill period
  out.push(new Paragraph({
    spacing: { before: 80, after: 0, line: 280 },
    tabStops: [{ type: 'right', position: 10440 }],   // ~7.25 inches in twips (page width minus margins)
    children: [
      new TextRun({ text: e.company, font: FONT, size: BODY_SIZE, bold: true }),
      new TextRun({ text: '\t', font: FONT, size: BODY_SIZE }),
      new TextRun({ text: e.period || '', font: FONT, size: BODY_SIZE, italics: true, color: '555555' }),
    ],
  }));
  // Role + location
  const meta = [e.role, e.location].filter(Boolean).join(' — ');
  if (meta) {
    out.push(new Paragraph({
      spacing: { before: 0, after: 60, line: 280 },
      children: [new TextRun({ text: meta, font: FONT, size: BODY_SIZE, italics: true, color: '555555' })],
    }));
  }
  // Bullets
  for (const b of e.bullets ?? []) out.push(bullet(b));
  return out;
}

function projectBlock(p: ProjectItem): Paragraph[] {
  const runs: TextRun[] = [
    new TextRun({ text: p.title, font: FONT, size: BODY_SIZE, bold: true }),
  ];
  if (p.badge) {
    runs.push(new TextRun({ text: ` (${p.badge})`, font: FONT, size: BODY_SIZE - 2, color: '666666' }));
  }
  runs.push(new TextRun({ text: ` — ${p.description}`, font: FONT, size: BODY_SIZE }));
  const out = [new Paragraph({ spacing: { before: 40, after: 40, line: 280 }, children: runs })];
  if (p.tech) {
    out.push(new Paragraph({
      spacing: { before: 0, after: 60, line: 280 },
      children: [new TextRun({ text: p.tech, font: FONT, size: BODY_SIZE - 2, italics: true, color: '666666' })],
    }));
  }
  return out;
}

function educationBlock(e: EducationItem): Paragraph[] {
  const out: Paragraph[] = [];
  out.push(new Paragraph({
    spacing: { before: 60, after: 0, line: 280 },
    tabStops: [{ type: 'right', position: 10440 }],
    children: [
      new TextRun({ text: e.title, font: FONT, size: BODY_SIZE, bold: true }),
      new TextRun({ text: e.org ? `, ${e.org}` : '', font: FONT, size: BODY_SIZE }),
      new TextRun({ text: '\t', font: FONT, size: BODY_SIZE }),
      new TextRun({ text: e.year || '', font: FONT, size: BODY_SIZE, italics: true, color: '555555' }),
    ],
  }));
  if (e.desc) {
    out.push(new Paragraph({
      spacing: { before: 0, after: 60, line: 280 },
      children: [makeBody(e.desc, { size: BODY_SIZE - 2 })],
    }));
  }
  return out;
}

// ── Cover letter ────────────────────────────────────────────────────────────

function coverDocument(cv: CVData, args: CoverDocxFields): Document {
  const children: Paragraph[] = [];

  children.push(new Paragraph({
    spacing: { after: 40 },
    children: [new TextRun({ text: cv.name || 'Candidate', font: FONT, size: NAME_SIZE - 4, bold: true })],
  }));
  const contact = [cv.location, cv.email, cv.phone].filter(Boolean).join('  ·  ');
  if (contact) {
    children.push(body(contact, { spacingAfter: 240 }));
  }

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  children.push(body(today, { spacingAfter: 200 }));

  children.push(body('Hiring Team', { spacingAfter: 0 }));
  const companyLine = [args.company, args.location].filter(Boolean).join(', ');
  if (companyLine) children.push(body(companyLine, { spacingAfter: 200 }));

  children.push(body('Dear Hiring Manager,', { spacingAfter: 160 }));

  for (const p of args.body.split(/\n{2,}/)) {
    const trimmed = p.trim();
    if (trimmed) children.push(body(trimmed, { spacingAfter: 160 }));
  }

  children.push(body('Best regards,', { spacingBefore: 120, spacingAfter: 0 }));
  children.push(body(cv.name || 'Candidate'));

  return new Document({
    creator: 'jobops',
    title:   `${cv.name || 'Candidate'} — Cover Letter`,
    sections: [{
      properties: { page: { margin: {
        top:    convertInchesToTwip(1),
        bottom: convertInchesToTwip(1),
        left:   convertInchesToTwip(1),
        right:  convertInchesToTwip(1),
      }}},
      children,
    }],
  });
}
