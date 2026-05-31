// Single-page HTML tracker. Read-only for milestone 1; later milestones add status-change
// links that hit MCP tools via the same server.
import { getDb } from '../db.js';
import { escapeHtml } from '../core/html.js';

export function renderDashboard(): string {
  const db = getDb();
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'sourced'           THEN 1 ELSE 0 END) AS sourced,
      SUM(CASE WHEN status = 'ready_to_apply'    THEN 1 ELSE 0 END) AS ready_to_apply,
      SUM(CASE WHEN status = 'materials_drafted' THEN 1 ELSE 0 END) AS materials_drafted,
      SUM(CASE WHEN status = 'ready_to_review'   THEN 1 ELSE 0 END) AS ready_to_review,
      SUM(CASE WHEN status = 'applied'           THEN 1 ELSE 0 END) AS applied,
      SUM(CASE WHEN status = 'screen'            THEN 1 ELSE 0 END) AS screen,
      SUM(CASE WHEN status = 'onsite'            THEN 1 ELSE 0 END) AS onsite,
      SUM(CASE WHEN status = 'offer'             THEN 1 ELSE 0 END) AS offer,
      SUM(CASE WHEN status = 'rejected'          THEN 1 ELSE 0 END) AS rejected,
      COUNT(*)                                              AS total
    FROM jobs
  `).get() as Record<string, number>;

  // Latest 30 evaluated/scored jobs, newest first
  const rows = db.prepare(`
    SELECT
      j.id, j.title, j.score_total, j.status, j.role_category, j.seniority,
      COALESCE(c.name, j.company_name_raw) AS company_name,
      j.location_raw AS location,
      j.source_url, j.discovered_at, j.scored_at,
      (SELECT er.id FROM eval_reports er WHERE er.job_id = j.id ORDER BY er.created_at DESC LIMIT 1) AS report_id,
      (SELECT er.html_path FROM eval_reports er WHERE er.job_id = j.id ORDER BY er.created_at DESC LIMIT 1) AS report_html
    FROM jobs j
    LEFT JOIN companies c ON c.id = j.company_id
    ORDER BY datetime(j.discovered_at) DESC
    LIMIT 30
  `).all() as any[];

  const card = (label: string, n: number) =>
    `<div class="card"><div class="n">${n ?? 0}</div><div class="lbl">${label}</div></div>`;

  const tier = (s: number | null) => {
    if (s == null) return '<span class="tier muted">—</span>';
    if (s >= 85) return `<span class="tier a">${s}</span>`;
    if (s >= 75) return `<span class="tier b">${s}</span>`;
    if (s >= 60) return `<span class="tier c">${s}</span>`;
    return `<span class="tier d">${s}</span>`;
  };

  const tbody = rows.map((r) => `
    <tr>
      <td>${tier(r.score_total)}</td>
      <td>${escapeHtml(r.company_name)}</td>
      <td><a href="${escapeHtml(r.source_url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></td>
      <td>${escapeHtml(r.role_category ?? '')}</td>
      <td>${escapeHtml(r.seniority ?? '')}</td>
      <td><code>${escapeHtml(r.status)}</code></td>
      <td>${escapeHtml(r.location ?? '')}</td>
      <td>${r.report_html ? `<a href="/files/${escapeHtml(r.report_html)}">report</a>` : '<span class="muted">—</span>'}</td>
      <td class="meta">${escapeHtml((r.discovered_at ?? '').slice(0, 16))}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>mcp-jsa tracker</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #fafbfc; color: #1a1a2e; }
  header { padding: 1.4rem 1.6rem; border-bottom: 1px solid #e2e2e2; background: #fff; display: flex; justify-content: space-between; align-items: baseline; }
  header h1 { margin: 0; font-size: 1.05rem; letter-spacing: 0.04em; text-transform: uppercase; color: hsl(187, 74%, 32%); }
  header .meta { color: #777; font-size: 0.85rem; }
  main { padding: 1.4rem 1.6rem; max-width: 1180px; margin: 0 auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.75rem; margin-bottom: 1.4rem; }
  .card { background: #fff; border: 1px solid #e2e2e2; border-radius: 4px; padding: 0.75rem 0.9rem; }
  .card .n { font-size: 1.4rem; font-weight: 700; }
  .card .lbl { color: #555; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e2e2; }
  th, td { text-align: left; padding: 0.55rem 0.7rem; border-bottom: 1px solid #f0f0f0; font-size: 0.88rem; vertical-align: top; }
  th { background: #f6f6f8; text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.72rem; color: #555; }
  td.meta { color: #777; font-size: 0.8rem; }
  .tier { font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 3px; color: #fff; }
  .tier.a { background: hsl(140, 60%, 38%); }
  .tier.b { background: hsl(195, 60%, 42%); }
  .tier.c { background: hsl(36,  80%, 45%); }
  .tier.d { background: hsl(8,   55%, 50%); }
  .muted { color: #999; }
  code { background: #f0f0f3; padding: 0.05rem 0.4rem; border-radius: 2px; font-size: 0.78em; }
  a { color: hsl(270, 70%, 45%); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { padding: 3rem; text-align: center; color: #777; }
</style>
</head>
<body>
<header>
  <h1>mcp-jsa tracker</h1>
  <span class="meta">${counts.total ?? 0} jobs in pipeline · /files served from output/</span>
</header>
<main>
  <div class="cards">
    ${card('Sourced',           counts.sourced)}
    ${card('Ready to apply',    counts.ready_to_apply)}
    ${card('Materials drafted', counts.materials_drafted)}
    ${card('Applied',           counts.applied)}
    ${card('Screen',            counts.screen)}
    ${card('Onsite',            counts.onsite)}
    ${card('Offer',             counts.offer)}
    ${card('Rejected',          counts.rejected)}
  </div>
  ${rows.length === 0 ? `
    <div class="empty">
      No jobs yet. Wire your chat client to <code>evaluate_job</code> and paste a JD or URL to get started.
    </div>` : `
    <table>
      <thead>
        <tr>
          <th>Score</th>
          <th>Company</th>
          <th>Title</th>
          <th>Role</th>
          <th>Level</th>
          <th>Status</th>
          <th>Location</th>
          <th>Report</th>
          <th>Discovered</th>
        </tr>
      </thead>
      <tbody>${tbody}</tbody>
    </table>`}
</main>
</body></html>`;
}

