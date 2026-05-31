// eval_reports repo + HTML rendering.
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../config.js';
import { getDb, runInWriteLock } from '../db.js';
import { escapeHtml } from './html.js';

export interface ReportBlocks {
  archetype_detected?: string | null;
  block_role_summary?: string | null;
  block_cv_match?:     string | null;
  block_level?:        string | null;
  block_comp?:         string | null;
  block_personalize?:  string | null;
  block_interview?:    string | null;
  block_legitimacy?:   string | null;
  keywords?:           string[] | null;
}

export interface ReportRow extends Required<ReportBlocks> {
  id:         string;
  job_id:     string;
  mode:       'chat' | 'api';
  raw_input:  string;
  html_path:  string;
  created_at: string;
}

const REPORTS_SUBDIR = 'reports';

export async function saveReport(args: {
  job_id:    string;
  mode:      'chat' | 'api';
  raw_input: string;
  blocks:    ReportBlocks;
  scores?:   { resume_fit?: number; taste_fit?: number; visa_fit?: number; score_total?: number;
               reasoning?: string; concerns?: string | null; role_category?: string; seniority?: string };
}): Promise<{ id: string; relativeHtmlPath: string; absoluteHtmlPath: string; url: string }> {
  return runInWriteLock(async () => {
    const db = getDb();
    const id = randomUUID();
    const html = renderReportHtml({
      reportId: id,
      jobId:    args.job_id,
      mode:     args.mode,
      blocks:   args.blocks,
      scores:   args.scores,
      rawInput: args.raw_input,
    });
    const outDir = resolve(config.outputDir, REPORTS_SUBDIR);
    mkdirSync(outDir, { recursive: true });
    const relativeHtmlPath = `${REPORTS_SUBDIR}/${id}.html`;
    const absoluteHtmlPath = resolve(config.outputDir, relativeHtmlPath);
    writeFileSync(absoluteHtmlPath, html, 'utf-8');

    db.prepare(`
      INSERT INTO eval_reports (
        id, job_id, mode, archetype_detected,
        block_role_summary, block_cv_match, block_level, block_comp,
        block_personalize, block_interview, block_legitimacy,
        keywords, raw_input, html_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.job_id,
      args.mode,
      args.blocks.archetype_detected ?? null,
      args.blocks.block_role_summary ?? null,
      args.blocks.block_cv_match ?? null,
      args.blocks.block_level ?? null,
      args.blocks.block_comp ?? null,
      args.blocks.block_personalize ?? null,
      args.blocks.block_interview ?? null,
      args.blocks.block_legitimacy ?? null,
      args.blocks.keywords ? JSON.stringify(args.blocks.keywords) : null,
      args.raw_input,
      relativeHtmlPath,
    );

    if (args.scores) {
      // Server is the source of truth for score_total — when visa is disabled, we
      // recompute from resume/taste regardless of what the chat (or LLM) returned.
      const resumeFit  = nonNeg(args.scores.resume_fit);
      const tasteFit   = nonNeg(args.scores.taste_fit);
      const visaFit    = config.visaScoringEnabled ? nonNeg(args.scores.visa_fit) : null;
      const scoreTotal = config.visaScoringEnabled
        ? nonNeg(args.scores.score_total)
        : combineNoVisa(resumeFit, tasteFit);
      db.prepare(`
        UPDATE jobs SET
          score_resume_fit = ?,
          score_taste_fit  = ?,
          score_visa_fit   = ?,
          score_total      = ?,
          role_category    = COALESCE(?, role_category),
          seniority        = COALESCE(?, seniority),
          score_detail     = ?,
          scored_at        = CURRENT_TIMESTAMP,
          updated_at       = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        resumeFit, tasteFit, visaFit, scoreTotal,
        args.scores.role_category ?? null,
        args.scores.seniority ?? null,
        JSON.stringify({
          reasoning:  args.scores.reasoning ?? null,
          concerns:   args.scores.concerns ?? null,
          mode:       args.mode,
          eval_report_id: id,
          visa_scoring_enabled: config.visaScoringEnabled,
        }),
        args.job_id,
      );
    }

    return {
      id,
      relativeHtmlPath,
      absoluteHtmlPath,
      url: `${config.baseUrl}/files/${relativeHtmlPath}`,
    };
  });
}

export function getLatestReport(jobId: string): ReportRow | null {
  const row = getDb().prepare(`
    SELECT * FROM eval_reports
    WHERE job_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).get(jobId) as any;
  if (!row) return null;
  return {
    ...row,
    keywords: row.keywords ? JSON.parse(row.keywords) : null,
  } as ReportRow;
}

function nonNeg(n: number | undefined): number | null {
  if (n === undefined || n === null) return null;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

// Renormalized weights when visa scoring is off. Mirrors VISA_DISABLED_PREFIX in modes.ts.
export function combineNoVisa(resume: number | null, taste: number | null): number | null {
  if (resume == null || taste == null) return null;
  return Math.round(resume * 0.6 + taste * 0.4);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderReportHtml(args: {
  reportId: string;
  jobId: string;
  mode: 'chat' | 'api';
  blocks: ReportBlocks;
  rawInput: string;
  scores?: { resume_fit?: number; taste_fit?: number; visa_fit?: number; score_total?: number;
             reasoning?: string; concerns?: string | null; role_category?: string; seniority?: string };
}): string {
  const block = (title: string, body: string | null | undefined) => body
    ? `<section><h2>${escapeHtml(title)}</h2><div class="prose">${mdToHtml(body)}</div></section>`
    : '';
  const visaSeg = config.visaScoringEnabled
    ? ` v:${args.scores?.visa_fit ?? '—'}`
    : '';
  const scoreBadge = args.scores?.score_total != null
    ? `<span class="score">total ${args.scores.score_total}</span>
       <span class="sub">r:${args.scores.resume_fit ?? '—'}
                         t:${args.scores.taste_fit  ?? '—'}${visaSeg}</span>`
    : '<span class="score muted">unscored</span>';
  const keywords = (args.blocks.keywords ?? []).map(k => `<code>${escapeHtml(k)}</code>`).join(' ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Evaluation ${args.reportId.slice(0, 8)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 880px;
         margin: 2rem auto; padding: 0 1rem; line-height: 1.55; color: #1a1a2e; }
  h1 { margin-bottom: 0.25rem; }
  .meta { color: #555; font-size: 0.9rem; margin-bottom: 1.25rem; }
  .score { background: #1a1a2e; color: #fff; padding: 0.15rem 0.55rem; border-radius: 3px; font-weight: 600; }
  .score.muted { background: #999; }
  .sub { color: #555; font-size: 0.85rem; margin-left: 0.5rem; }
  section { margin-bottom: 1.5rem; }
  h2 { font-size: 1.05rem; text-transform: uppercase; letter-spacing: 0.05em;
       color: hsl(187, 74%, 32%); border-bottom: 1.5px solid #e2e2e2; padding-bottom: 4px; }
  .prose pre { white-space: pre-wrap; background: #f6f6f8; padding: 0.6rem 0.8rem;
               border-left: 3px solid #ccc; border-radius: 3px; font-size: 0.9em; }
  .keywords code { background: #f0f0f3; padding: 0.1rem 0.4rem; border-radius: 2px;
                   margin: 0.1rem 0.15rem 0.1rem 0; display: inline-block; font-size: 0.85em; }
  .raw  { max-height: 280px; overflow: auto; }
  a { color: hsl(270, 70%, 45%); }
</style>
</head>
<body>
<h1>Evaluation Report</h1>
<div class="meta">
  ${scoreBadge} &nbsp;·&nbsp;
  mode <code>${args.mode}</code> ·
  archetype <code>${escapeHtml(args.blocks.archetype_detected ?? 'unset')}</code> ·
  role <code>${escapeHtml(args.scores?.role_category ?? '—')}</code> ·
  level <code>${escapeHtml(args.scores?.seniority ?? '—')}</code> ·
  <a href="/">tracker</a>
</div>
${args.scores?.reasoning
  ? `<section><h2>Why</h2><p>${escapeHtml(args.scores.reasoning)}</p>${args.scores.concerns ? `<p><strong>Concerns:</strong> ${escapeHtml(args.scores.concerns)}</p>` : ''}</section>`
  : ''}
${block('A) Role Summary',        args.blocks.block_role_summary)}
${block('B) CV Match',            args.blocks.block_cv_match)}
${block('C) Level & Strategy',    args.blocks.block_level)}
${block('D) Comp & Demand',       args.blocks.block_comp)}
${block('E) Personalization Plan',args.blocks.block_personalize)}
${block('F) Interview Plan',      args.blocks.block_interview)}
${block('G) Posting Legitimacy',  args.blocks.block_legitimacy)}
${keywords ? `<section class="keywords"><h2>Keywords</h2><div>${keywords}</div></section>` : ''}
<section><h2>Normalized JD (input)</h2><pre class="raw">${escapeHtml(args.rawInput)}</pre></section>
</body></html>`;
}

// Minimal markdown → HTML: headers, lists, paragraphs, fenced code, inline code, links, bold.
// We deliberately avoid pulling in a dependency — the chat will mostly send tables and lists
// and this covers ~95% of cases without DOM tooling.
function mdToHtml(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  let inTable = false;
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${inlineMd(paraBuf.join(' '))}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flushPara(); closeList(); closeTable();
      if (!inCode) { out.push('<pre><code>'); inCode = true; }
      else         { out.push('</code></pre>');  inCode = false; }
      continue;
    }
    if (inCode) { out.push(escapeHtml(line)); continue; }

    if (/^\|.*\|/.test(line)) {
      flushPara(); closeList();
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      const isSep = cells.every(c => /^:?-+:?$/.test(c));
      if (isSep) continue;
      if (!inTable) { out.push('<table><tbody>'); inTable = true; }
      out.push('<tr>' + cells.map(c => `<td>${inlineMd(c)}</td>`).join('') + '</tr>');
      continue;
    } else { closeTable(); }

    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineMd(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    } else { closeList(); }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (line.trim() === '') { flushPara(); continue; }
    paraBuf.push(line);
  }
  flushPara(); closeList(); closeTable(); if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}
