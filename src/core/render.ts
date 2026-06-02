// HTML → PDF renderer. Port of career-ops/generate-pdf.mjs with two changes:
//   - the source HTML is built here from the parsed CV + the career-ops template
//   - ATS unicode normalization stays (em-dash → -, smart quotes → ASCII, NBSP → space, ...)
//
// The CV template lives in templates/cv-template.html. Fonts live in fonts/ and are
// referenced from the template via ./fonts/*; we resolve them to absolute file:// URLs
// before letting Chromium render.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';

import { config } from '../config.js';
import { parseCV, type CVData } from './cv_parse.js';
import { getJob } from './jobs.js';
import { escapeHtml } from './html.js';
import { scanForVisaLeakage } from './outreach_safety.js';
import { getSharedBrowser, closeSharedBrowser } from './browser.js';
import { loadTemplate, effectiveDefaultTemplate } from './templates.js';

// Templates are looked up per-theme; the loader does its own cache where useful.
// We resolve fresh on each call so a theme change is picked up immediately.
function loadCvTemplate(theme: string): string {
  return loadTemplate(theme, 'resume.html').body;
}
function loadCoverTemplate(theme: string): string {
  return loadTemplate(theme, 'cover.html').body;
}

// Re-exported for `src/server.ts` shutdown, which still passes through this module.
export async function closeBrowser(): Promise<void> { await closeSharedBrowser(); }

// ── Public entry point ───────────────────────────────────────────────────────

export interface RenderArgs {
  job_id: string;
  kind:   'resume' | 'cover' | 'both';
  cover_body?: string;     // milestone 1 takes whatever the chat sends; m2 reads applications.cover_letter_draft
  page_format?: 'a4' | 'letter';
  /** Theme name (see core/templates.ts). Defaults to MCP_JSA_DEFAULT_TEMPLATE or "default". */
  theme?: string;
}

export interface RenderedFile {
  kind:     'resume' | 'cover';
  path:     string;        // relative to outputDir
  abs:      string;
  url:      string;
  bytes:    number;
}

export async function renderPdf(args: RenderArgs): Promise<RenderedFile[]> {
  const job = getJob(args.job_id);
  if (!job) throw new Error(`renderPdf: no job ${args.job_id}`);
  // Hard rail: visa data must never enter a resume or cover letter. The materials
  // generator scans tailored content before persisting; this catches anything the
  // chat hand-types into cover_body.
  if (args.cover_body) {
    const leaks = scanForVisaLeakage(args.cover_body);
    if (leaks.length) throw new Error(`render_pdf: cover_body failed visa rail — ${JSON.stringify(leaks)}`);
  }
  const format = args.page_format ?? 'letter';
  const theme  = args.theme ?? effectiveDefaultTemplate();
  const cv = parseCV();

  const outputs: RenderedFile[] = [];
  const browser = await getSharedBrowser();

  if (args.kind === 'resume' || args.kind === 'both') {
    let html: string;
    try { html = renderResumeHtml(cv, theme); }
    catch (err: any) { throw new Error(`render_pdf (theme="${theme}", kind=resume): ${err?.message ?? err}`); }
    const file = await writeAndPdf(browser, html, `resume-${slug(job.title)}-${args.job_id.slice(0, 8)}.pdf`, format);
    outputs.push({ kind: 'resume', ...file });
  }
  if (args.kind === 'cover' || args.kind === 'both') {
    if (!args.cover_body) throw new Error('render_pdf: kind=cover|both requires cover_body');
    let html: string;
    try {
      html = renderCoverHtml(cv, {
        company:  job.company_name_raw,
        location: job.location_raw ?? '',
        body:     args.cover_body,
      }, theme);
    } catch (err: any) { throw new Error(`render_pdf (theme="${theme}", kind=cover): ${err?.message ?? err}`); }
    const file = await writeAndPdf(browser, html, `cover-${slug(job.title)}-${args.job_id.slice(0, 8)}.pdf`, format);
    outputs.push({ kind: 'cover', ...file });
  }
  return outputs;
}

// ── Template fill ────────────────────────────────────────────────────────────

function renderResumeHtml(cv: CVData, theme: string): string {
  const tpl = loadCvTemplate(theme);
  const replacements: Record<string, string> = {
    LANG:               'en',
    NAME:               cv.name,
    PHONE:              cv.phone,
    EMAIL:              cv.email,
    LINKEDIN_URL:       cv.linkedin_url,
    LINKEDIN_DISPLAY:   cv.linkedin_display,
    PORTFOLIO_URL:      cv.portfolio_url,
    PORTFOLIO_DISPLAY:  cv.portfolio_display,
    LOCATION:           cv.location,
    PAGE_WIDTH:         '7.4in',
    SECTION_SUMMARY:       'Professional Summary',
    SECTION_COMPETENCIES:  'Core Competencies',
    SECTION_EXPERIENCE:    'Work Experience',
    SECTION_PROJECTS:      'Projects',
    SECTION_EDUCATION:     'Education',
    SECTION_CERTIFICATIONS:'Certifications',
    SECTION_SKILLS:        'Skills',
    SUMMARY_TEXT:       escapeHtml(cv.summary),
    COMPETENCIES:       cv.competencies.map(c => `<span class="competency-tag">${escapeHtml(c)}</span>`).join('\n      '),
    EXPERIENCE:         cv.experiences.map(renderExperience).join('\n    '),
    PROJECTS:           cv.projects.map(renderProject).join('\n    '),
    EDUCATION:          cv.education.map(renderEducation).join('\n    '),
    CERTIFICATIONS:     cv.certifications.length
                          ? cv.certifications.map(renderCert).join('\n    ')
                          : '<div class="cert-item"><span class="cert-title muted">—</span></div>',
    SKILLS:             renderSkills(cv.skills),
  };
  let html = tpl;
  for (const [k, v] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${k}}}`, v ?? '');
  }
  return html;
}

function renderExperience(e: any): string {
  return `
    <div class="job">
      <div class="job-header">
        <span class="job-company">${escapeHtml(e.company)}</span>
        <span class="job-period">${escapeHtml(e.period)}</span>
      </div>
      <div class="job-role">${escapeHtml(e.role)}${e.location ? ` <span class="job-location">· ${escapeHtml(e.location)}</span>` : ''}</div>
      <ul>
        ${(e.bullets ?? []).map((b: string) => `<li>${inlineBold(escapeHtml(b))}</li>`).join('\n        ')}
      </ul>
    </div>`;
}

function renderProject(p: any): string {
  return `
    <div class="project">
      <span class="project-title">${escapeHtml(p.title)}</span>${p.badge ? ` <span class="project-badge">${escapeHtml(p.badge)}</span>` : ''}
      <div class="project-desc">${inlineBold(escapeHtml(p.description))}</div>
      ${p.tech ? `<div class="project-tech">${escapeHtml(p.tech)}</div>` : ''}
    </div>`;
}

function renderEducation(e: any): string {
  return `
    <div class="edu-item">
      <div class="edu-header">
        <span class="edu-title">${escapeHtml(e.title)}${e.org ? `, <span class="edu-org">${escapeHtml(e.org)}</span>` : ''}</span>
        <span class="edu-year">${escapeHtml(e.year)}</span>
      </div>
      ${e.desc ? `<div class="edu-desc">${escapeHtml(e.desc)}</div>` : ''}
    </div>`;
}

function renderCert(c: any): string {
  return `
    <div class="cert-item">
      <span class="cert-title">${escapeHtml(c.title)}</span>
      <span class="cert-org">${escapeHtml(c.org)}</span>
      <span class="cert-year">${escapeHtml(c.year)}</span>
    </div>`;
}

function renderSkills(skills: { category: string; items: string }[]): string {
  if (!skills.length) return '<div class="skill-item muted">—</div>';
  return `<div class="skills-grid">
    ${skills.map(s => `<div class="skill-item"><span class="skill-category">${escapeHtml(s.category)}:</span> ${escapeHtml(s.items)}</div>`).join('\n    ')}
  </div>`;
}

function renderCoverHtml(cv: CVData, args: { company: string; location: string; body: string }, theme: string): string {
  const tpl = loadCoverTemplate(theme);
  const contactBits = [cv.phone, cv.email, cv.linkedin_display, cv.portfolio_display].filter(Boolean);
  const body = args.body
    .split(/\n{2,}/)
    .map(p => `<p>${escapeHtml(p.trim())}</p>`)
    .join('\n');
  const replacements: Record<string, string> = {
    NAME: cv.name,
    CONTACT_LINE: contactBits.map(escapeHtml).join(' &nbsp;·&nbsp; '),
    DATE: new Date().toISOString().slice(0, 10),
    COMPANY: escapeHtml(args.company),
    COMPANY_LOCATION: args.location ? `, ${escapeHtml(args.location)}` : '',
    BODY: body,
  };
  let html = tpl;
  for (const [k, v] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${k}}}`, v ?? '');
  }
  return html;
}

// ── PDF write path (Playwright) ──────────────────────────────────────────────

async function writeAndPdf(browser: Browser, html: string, filename: string, format: 'a4' | 'letter'): Promise<Omit<RenderedFile, 'kind'>> {
  // Rewrite font paths to absolute file:// URLs so Chromium can resolve them.
  const withFonts = html.replace(/url\(['"]?\.\/fonts\//g, `url('file://${config.fontsDir}/`);
  const normalized = normalizeAtsUnicode(withFonts);

  // Stage HTML next to the PDF so the chat can debug a render visually if needed.
  const subdir = 'pdfs';
  const outDir = resolve(config.outputDir, subdir);
  mkdirSync(outDir, { recursive: true });
  const htmlPath = resolve(outDir, filename.replace(/\.pdf$/, '.html'));
  writeFileSync(htmlPath, normalized, 'utf-8');

  const page = await browser.newPage();
  try {
    // Navigate to the staged HTML on disk so relative font URLs and fragment links work.
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => (document as any).fonts?.ready);
    const pdfPath = resolve(outDir, filename);
    const buf = await page.pdf({
      format,
      printBackground: true,
      margin: { top: '0.6in', right: '0.6in', bottom: '0.6in', left: '0.6in' },
      preferCSSPageSize: false,
    });
    writeFileSync(pdfPath, buf);
    const relative = `${subdir}/${filename}`;
    return {
      path:  relative,
      abs:   pdfPath,
      url:   `${config.baseUrl}/files/${relative}`,
      bytes: buf.length,
    };
  } finally {
    await page.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || randomUUID().slice(0, 8);
}

// Re-bold **text** inside bullet bodies — escapeHtml() escapes the asterisks, but we want
// proof points to render with weight in the template.
function inlineBold(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// Port of career-ops/generate-pdf.mjs ATS normalizer. Only touches body text — leaves
// style/script tags and URLs alone.
function normalizeAtsUnicode(html: string): string {
  const masks: string[] = [];
  const masked = html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    const tok = ` MASK${masks.length} `;
    masks.push(m);
    return tok;
  });

  let out = '';
  let i = 0;
  while (i < masked.length) {
    const lt = masked.indexOf('<', i);
    if (lt === -1) { out += sanitize(masked.slice(i)); break; }
    out += sanitize(masked.slice(i, lt));
    const gt = masked.indexOf('>', lt);
    if (gt === -1) { out += masked.slice(lt); break; }
    out += masked.slice(lt, gt + 1);
    i = gt + 1;
  }
  return out.replace(/ MASK(\d+) /g, (_, n) => masks[Number(n)]);

  function sanitize(t: string): string {
    return t
      .replace(/—/g, '-')   // em-dash
      .replace(/–/g, '-')   // en-dash
      .replace(/[“”„‟]/g, '"')
      .replace(/[‘’‚‛]/g, "'")
      .replace(/…/g, '...')
      .replace(/[​‌‍⁠﻿]/g, '')
      .replace(/ /g, ' ');
  }
}
