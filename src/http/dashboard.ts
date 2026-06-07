// Single-page HTML tracker + a /trash page. CRUD actions (status change, soft-delete,
// restore, purge) call the /api/* endpoints in http/app.ts, which share the SAME core logic
// (core/job_trash.ts) as the MCP chat tools — no duplicated mutation logic here.
import { getDb } from '../db.js';
import { escapeHtml } from '../core/html.js';
import { themeCss, themeInitScript, themeToggleButton } from './theme.js';
import { JOB_STATUSES, listTrashedJobs } from '../core/job_trash.js';

// ── shared styling + shell ────────────────────────────────────────────────────

function styles(): string {
  return `${themeCss()}
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: var(--bg-page); color: var(--text); }
  header { padding: 1.4rem 1.6rem; border-bottom: 1px solid var(--border); background: var(--bg-card);
           display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
  header h1 { margin: 0; font-size: 1.05rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--accent); }
  header h1 a { color: inherit; }
  header .meta { color: var(--text-muted); font-size: 0.85rem; }
  main { padding: 1.4rem 1.6rem; max-width: 1180px; margin: 0 auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.75rem; margin-bottom: 1.4rem; }
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem 0.9rem; box-shadow: var(--shadow); }
  .card .n { font-size: 1.4rem; font-weight: 700; color: var(--text); }
  .card .lbl { color: var(--text-2); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  table { width: 100%; border-collapse: collapse; background: var(--bg-card); border: 1px solid var(--border); box-shadow: var(--shadow); }
  th, td { text-align: left; padding: 0.55rem 0.7rem; border-bottom: 1px solid var(--border-soft);
           font-size: 0.88rem; vertical-align: top; color: var(--text); }
  th { background: var(--bg-soft); text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.72rem; color: var(--text-2); }
  td.meta { color: var(--text-muted); font-size: 0.8rem; }
  tr.removing { opacity: 0.35; transition: opacity 0.25s; }
  .tier { font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 3px; color: var(--tier-fg); display: inline-block; min-width: 1.6em; text-align: center; }
  .tier.a { background: var(--tier-a); } .tier.b { background: var(--tier-b); }
  .tier.c { background: var(--tier-c); } .tier.d { background: var(--tier-d); }
  .tier.muted { background: transparent; color: var(--text-muted); font-weight: 400; }
  .muted { color: var(--text-muted); }
  code { background: var(--code-bg); padding: 0.05rem 0.4rem; border-radius: 2px; font-size: 0.78em; color: var(--text-2); }
  a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
  .empty { padding: 3rem; text-align: center; color: var(--text-muted); }
  select.status-sel { font: inherit; font-size: 0.8rem; padding: 0.15rem 0.3rem; background: var(--bg-soft);
           color: var(--text); border: 1px solid var(--border); border-radius: 3px; }
  button.act { font: inherit; font-size: 0.78rem; padding: 0.18rem 0.5rem; border: 1px solid var(--border);
           border-radius: 3px; background: var(--bg-soft); color: var(--text-2); cursor: pointer; }
  button.act:hover { border-color: var(--accent); color: var(--text); }
  button.danger { color: #b42318; border-color: #f0b9b3; } button.danger:hover { background: #fee4e2; color: #912018; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: 1rem; }
  .banner { background: var(--bg-soft); border: 1px solid var(--border); border-left: 3px solid var(--accent);
            border-radius: 4px; padding: 0.7rem 0.9rem; font-size: 0.85rem; color: var(--text-2); margin-bottom: 1rem; }
  .banner.warn { border-left-color: #d92d20; }
  td.actions { white-space: nowrap; }
  td.actions button + button { margin-left: 0.3rem; }`;
}

function shell(title: string, body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
${themeInitScript()}
<style>${styles()}</style>
</head>
<body>
${themeToggleButton()}
${body}
<script>${script}</script>
</body></html>`;
}

const tier = (s: number | null) => {
  if (s == null) return '<span class="tier muted">—</span>';
  if (s >= 85) return `<span class="tier a">${s}</span>`;
  if (s >= 75) return `<span class="tier b">${s}</span>`;
  if (s >= 60) return `<span class="tier c">${s}</span>`;
  return `<span class="tier d">${s}</span>`;
};

function activeCounts() {
  return getDb().prepare(`
    SELECT
      SUM(CASE WHEN status = 'sourced'           THEN 1 ELSE 0 END) AS sourced,
      SUM(CASE WHEN status = 'ready_to_apply'    THEN 1 ELSE 0 END) AS ready_to_apply,
      SUM(CASE WHEN status = 'materials_drafted' THEN 1 ELSE 0 END) AS materials_drafted,
      SUM(CASE WHEN status = 'applied'           THEN 1 ELSE 0 END) AS applied,
      SUM(CASE WHEN status = 'screen'            THEN 1 ELSE 0 END) AS screen,
      SUM(CASE WHEN status = 'onsite'            THEN 1 ELSE 0 END) AS onsite,
      SUM(CASE WHEN status = 'offer'             THEN 1 ELSE 0 END) AS offer,
      SUM(CASE WHEN status = 'rejected'          THEN 1 ELSE 0 END) AS rejected,
      COUNT(*)                                                      AS total
    FROM jobs WHERE trashed_at IS NULL
  `).get() as Record<string, number>;
}
function trashedCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE trashed_at IS NOT NULL`).get() as { n: number }).n;
}

/** Card labels + the count keys they read — also used by the live /api/counts refresh. */
export const COUNT_CARDS: Array<[label: string, key: string]> = [
  ['Sourced', 'sourced'], ['Ready to apply', 'ready_to_apply'], ['Materials drafted', 'materials_drafted'],
  ['Applied', 'applied'], ['Screen', 'screen'], ['Onsite', 'onsite'], ['Offer', 'offer'], ['Rejected', 'rejected'],
];

export function countsJson(): Record<string, number> {
  return activeCounts();
}

// ── main tracker ──────────────────────────────────────────────────────────────

export function renderDashboard(): string {
  const db = getDb();
  const counts = activeCounts();
  const trashN = trashedCount();

  const rows = db.prepare(`
    SELECT j.id, j.title, j.score_total, j.status, j.role_category, j.seniority,
           COALESCE(c.name, j.company_name_raw) AS company_name,
           j.location_raw AS location, j.source_url, j.discovered_at,
           (SELECT er.html_path FROM eval_reports er WHERE er.job_id = j.id ORDER BY er.created_at DESC LIMIT 1) AS report_html
    FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
    WHERE j.trashed_at IS NULL
    ORDER BY datetime(j.discovered_at) DESC
    LIMIT 50
  `).all() as any[];

  const statusSelect = (id: string, current: string) =>
    `<select class="status-sel" data-id="${id}">` +
    JOB_STATUSES.map(s => `<option value="${s}"${s === current ? ' selected' : ''}>${s}</option>`).join('') +
    `</select>`;

  const cardsHtml = COUNT_CARDS.map(([label, key]) =>
    `<div class="card"><div class="n" data-count="${key}">${counts[key] ?? 0}</div><div class="lbl">${label}</div></div>`).join('');

  const tbody = rows.map((r) => `
    <tr data-id="${r.id}">
      <td>${tier(r.score_total)}</td>
      <td>${escapeHtml(r.company_name)}</td>
      <td><a href="${escapeHtml(r.source_url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></td>
      <td>${escapeHtml(r.role_category ?? '')}</td>
      <td>${escapeHtml(r.seniority ?? '')}</td>
      <td>${statusSelect(r.id, r.status)}</td>
      <td>${escapeHtml(r.location ?? '')}</td>
      <td>${r.report_html ? `<a href="/files/${escapeHtml(r.report_html)}">report</a>` : '<span class="muted">—</span>'}</td>
      <td class="meta">${escapeHtml((r.discovered_at ?? '').slice(0, 16))}</td>
      <td class="actions"><button class="act danger trash-btn" data-id="${r.id}" data-label="${escapeHtml(r.title)} @ ${escapeHtml(r.company_name)}" title="Move to trash (recoverable)">Trash</button></td>
    </tr>`).join('');

  const body = `
<header>
  <h1>mcp-jsa tracker</h1>
  <span class="meta">${counts.total ?? 0} active · <a href="/trash">trash (${trashN})</a> · /files from output/</span>
</header>
<main>
  <div class="cards">${cardsHtml}</div>
  ${rows.length === 0 ? `
    <div class="empty">No active jobs. Paste a JD/URL into <code>evaluate_job</code> to get started.${trashN ? ` (<a href="/trash">${trashN} in trash</a>)` : ''}</div>` : `
    <table>
      <thead><tr>
        <th>Score</th><th>Company</th><th>Title</th><th>Role</th><th>Level</th>
        <th>Status</th><th>Location</th><th>Report</th><th>Discovered</th><th></th>
      </tr></thead>
      <tbody>${tbody}</tbody>
    </table>`}
</main>`;

  const script = `
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const t = await r.text().catch(()=>''); alert('Action failed (' + r.status + '): ' + t); throw new Error(t); }
    return r.json();
  }
  async function refreshCounts() {
    try { const c = await (await fetch('/api/counts')).json();
      document.querySelectorAll('[data-count]').forEach(el => { el.textContent = c[el.dataset.count] ?? 0; }); } catch {}
  }
  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('select.status-sel'); if (!sel) return;
    await api('POST', '/api/jobs/' + sel.dataset.id + '/status', { status: sel.value });
    sel.closest('tr').style.background = 'var(--bg-soft)';
    setTimeout(() => { sel.closest('tr').style.background = ''; }, 600);
    refreshCounts();
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button.trash-btn'); if (!b) return;
    if (!confirm('Move to trash (recoverable): ' + b.dataset.label + '?')) return;
    await api('POST', '/api/jobs/' + b.dataset.id + '/trash');
    const tr = b.closest('tr'); tr.classList.add('removing'); setTimeout(() => tr.remove(), 250);
    refreshCounts();
  });`;

  return shell('mcp-jsa tracker', body, script);
}

// ── /trash page ─────────────────────────────────────────────────────────────--

export function renderTrashPage(): string {
  const items = listTrashedJobs();

  const tbody = items.map((r: any) => `
    <tr data-id="${r.job_id}">
      <td>${tier(r.score_total)}</td>
      <td>${escapeHtml(r.company ?? '')}</td>
      <td>${escapeHtml(r.title ?? '')}</td>
      <td><code>${escapeHtml(r.status ?? '')}</code></td>
      <td class="meta">${escapeHtml((r.trashed_at ?? '').slice(0, 16))}</td>
      <td class="actions">
        <button class="act restore-btn" data-id="${r.job_id}">Restore</button>
        <button class="act danger purge-btn" data-id="${r.job_id}" data-label="${escapeHtml(r.title ?? '')} @ ${escapeHtml(r.company ?? '')}">Delete permanently</button>
      </td>
    </tr>`).join('');

  const body = `
<header>
  <h1><a href="/">mcp-jsa tracker</a> › trash</h1>
  <span class="meta"><a href="/">← back to tracker</a></span>
</header>
<main>
  <div class="banner">
    <strong>Trashed (recoverable).</strong> These jobs are hidden from the tracker but not deleted —
    <em>Restore</em> brings one back to its prior state. <em>Delete permanently</em> and <em>Empty trash</em> are
    irreversible hard deletes (a timestamped backup is written to the project root regardless).
  </div>
  <div class="toolbar">
    <span class="meta">${items.length} job(s) in trash</span>
    ${items.length ? `<button class="act danger" id="empty-trash">Empty trash (delete all ${items.length})</button>` : ''}
  </div>
  ${items.length === 0 ? `<div class="empty">Trash is empty.</div>` : `
    <table>
      <thead><tr><th>Score</th><th>Company</th><th>Title</th><th>Prior status</th><th>Trashed</th><th></th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>`}
</main>`;

  const script = `
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const t = await r.text().catch(()=>''); alert('Action failed (' + r.status + '): ' + t); throw new Error(t); }
    return r.json();
  }
  document.addEventListener('click', async (e) => {
    const restore = e.target.closest('button.restore-btn');
    const purge   = e.target.closest('button.purge-btn');
    const empty   = e.target.closest('#empty-trash');
    if (restore) {
      await api('POST', '/api/jobs/' + restore.dataset.id + '/restore');
      restore.closest('tr').remove();
    } else if (purge) {
      if (!confirm('PERMANENTLY delete: ' + purge.dataset.label + '?\\n\\nThis cannot be undone (a backup is written first).')) return;
      await api('POST', '/api/jobs/' + purge.dataset.id + '/purge');
      purge.closest('tr').remove();
    } else if (empty) {
      if (!confirm('PERMANENTLY delete ALL trashed jobs?\\n\\nThis empties the trash and cannot be undone. A timestamped backup is written to the project root first.')) return;
      const r = await api('POST', '/api/trash/purge-all', { confirm: true });
      alert('Permanently deleted ' + r.purged + ' job(s). Backup: ' + (r.backup_path || '(none)'));
      location.reload();
    }
  });`;

  return shell('mcp-jsa trash', body, script);
}
