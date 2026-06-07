// Shared health-check logic for `doctor` — consumed by BOTH the CLI `doctor` subcommand
// (pretty-printed, sets the exit code) and the `doctor` MCP tool (returns this structured
// report to the chat). One source of truth so the two never drift.
//
// Every check is read-only. `context` tunes a few checks for the situation:
//   'cold'   — the CLI, run before `start`. Chromium-missing is a hard failure; the
//              summary points at `start`.
//   'server' — the MCP tool, run inside an already-bound server. Things that only matter
//              at cold start are relabelled as informational (the server is obviously up),
//              and "would-block-a-tool" gaps are warnings rather than failures.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../config.js';

export type DoctorContext = 'cold' | 'server';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  id:      string;
  label:   string;        // short category label
  status:  CheckStatus;
  detail:  string;        // human-readable one-liner
  fix?:    string;        // optional remediation hint
}

export interface DoctorReport {
  ok:       boolean;                 // no failing checks
  context:  DoctorContext;
  package:  { name: string; version: string };
  counts:   { pass: number; warn: number; fail: number; info: number };
  checks:   DoctorCheck[];
  summary:  string;
}

function pkgInfo(): { name: string; version: string } {
  try {
    const p = JSON.parse(readFileSync(resolve(config.installDir, 'package.json'), 'utf-8'));
    return { name: p.name ?? 'job_ops-mcp', version: p.version ?? '0.0.0' };
  } catch {
    return { name: 'job_ops-mcp', version: 'unknown' };
  }
}

export async function runDoctorChecks(opts: { context: DoctorContext }): Promise<DoctorReport> {
  const ctx = opts.context;
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  // 1. Node version.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= 20
    ? { id: 'node', label: 'Node', status: 'pass', detail: `Node ${process.versions.node} (>= 20)` }
    : { id: 'node', label: 'Node', status: 'fail', detail: `Node ${process.versions.node} — need >= 20`, fix: 'Install Node 20+ from https://nodejs.org/' });

  // 2. Chromium (Playwright). Needed by scan_portals + apply_prefill only.
  let chromiumPath: string | null = null;
  try {
    const { chromium } = await import('playwright');
    const p = chromium.executablePath();
    if (p && existsSync(p)) chromiumPath = p;
  } catch { /* fall through */ }
  if (chromiumPath) {
    add({ id: 'chromium', label: 'Chromium', status: 'pass', detail: `Playwright Chromium: ${chromiumPath}` });
  } else {
    // Cold start: hard requirement. Running server: only scan/apply tools are affected.
    add({
      id: 'chromium', label: 'Chromium',
      status: ctx === 'server' ? 'warn' : 'fail',
      detail: ctx === 'server'
        ? 'Playwright Chromium missing — scan_portals and apply_prefill will fail until installed (other tools work).'
        : 'Playwright Chromium missing.',
      fix: 'npx playwright install chromium',
    });
  }

  // 3. Project root + user config files.
  const projectRoot = config.projectRoot;
  add({ id: 'project_root', label: 'Project root', status: 'info', detail: projectRoot });
  for (const file of ['cv.md', 'config/profile.yml', 'portals.yml']) {
    const p = resolve(projectRoot, file);
    if (existsSync(p)) {
      const size = statSync(p).size;
      add(size < 200
        ? { id: `file:${file}`, label: 'Config file', status: 'warn', detail: `${file} present but suspiciously small (${size} bytes) — did you replace the placeholders?` }
        : { id: `file:${file}`, label: 'Config file', status: 'pass', detail: `${file} (${size} bytes)` });
    } else {
      add({ id: `file:${file}`, label: 'Config file', status: 'fail', detail: `${file} missing`, fix: 'npx job_ops-mcp init' });
    }
  }

  // 4. LLM provider / key (BYO-key fallback for api/batch when sampling is unavailable).
  const provider = (config.llmProvider || 'gemini').toLowerCase();
  const haveKey = (provider === 'gemini'   && !!process.env.GEMINI_API_KEY)
               || (provider === 'deepseek' && !!process.env.DEEPSEEK_API_KEY);
  if (haveKey) {
    add({ id: 'llm', label: 'LLM provider', status: 'pass', detail: `${provider} (key set)` });
  } else if (provider === 'none') {
    add({ id: 'llm', label: 'LLM provider', status: 'pass', detail: 'none (chat-mode / sampling only)' });
  } else {
    add({
      id: 'llm', label: 'LLM provider', status: 'warn',
      detail: `${provider} but no API key — chat-mode + sampling work; the BYO-key fallback for api/batch will error.`,
      fix: `set ${provider === 'gemini' ? 'GEMINI_API_KEY' : 'DEEPSEEK_API_KEY'}`,
    });
  }

  // 5. Sampling posture (how api-path scoring runs). Read the resolved config flag.
  add(config.samplingEnabled
    ? { id: 'sampling', label: 'Scoring', status: 'pass', detail: 'MCP sampling preferred (client model — no key); BYO key is the fallback. Sampling/elicitation need a stdio client (e.g. Claude Desktop); HTTP clients use the fallback paths.' }
    : { id: 'sampling', label: 'Scoring', status: 'warn', detail: 'sampling disabled (MCP_JSA_SAMPLING=false) — api/batch paths require a BYO LLM key.' });

  // 6. Visa scoring.
  add({ id: 'visa', label: 'Visa scoring', status: 'pass',
        detail: config.visaScoringEnabled ? 'on (0.5/0.3/0.2)' : 'off (0.6/0.4, visa tools hidden)' });

  // 7. Templates — active default + bundled/user counts.
  try {
    const { listThemes, effectiveDefaultTemplate } = await import('./templates.js');
    const themes = listThemes();
    const def    = effectiveDefaultTemplate();
    const userCount    = themes.filter(t => t.source === 'user').length;
    const bundledCount = themes.length - userCount;
    const misconfigured = !!process.env.MCP_JSA_DEFAULT_TEMPLATE && process.env.MCP_JSA_DEFAULT_TEMPLATE !== def;
    add({
      id: 'templates', label: 'Templates',
      status: misconfigured ? 'warn' : 'pass',
      detail: `${bundledCount} bundled${userCount ? `, ${userCount} user` : ''} — default: ${def}`
            + (misconfigured ? ` (MCP_JSA_DEFAULT_TEMPLATE="${process.env.MCP_JSA_DEFAULT_TEMPLATE}" not found, fell back to "${def}")` : ''),
    });
  } catch (e: any) {
    add({ id: 'templates', label: 'Templates', status: 'warn', detail: `templates check failed: ${e?.message ?? e}` });
  }

  // 8. Mode files — user-overridden (project root) vs bundled defaults.
  try {
    const { MODE_FILES, modeSource } = await import('./modes.js');
    const sources    = MODE_FILES.map(f => ({ f, src: modeSource(f) }));
    const overridden = sources.filter(s => s.src === 'user').map(s => s.f.replace(/\.md$/, ''));
    const missing    = sources.filter(s => s.src === 'missing').map(s => s.f);
    if (missing.length) {
      add({ id: 'modes', label: 'Modes', status: 'fail', detail: `mode file(s) missing entirely: ${missing.join(', ')}`, fix: 'reinstall the package' });
    } else if (overridden.length) {
      add({ id: 'modes', label: 'Modes', status: 'pass',
            detail: `${overridden.length}/${MODE_FILES.length} user-overridden (${overridden.join(', ')})${overridden.length < MODE_FILES.length ? '; rest bundled defaults' : ''}` });
    } else {
      add({ id: 'modes', label: 'Modes', status: 'pass', detail: 'all bundled defaults — edit modes/*.md in your project root to customize (init scaffolds them)' });
    }
  } catch (e: any) {
    add({ id: 'modes', label: 'Modes', status: 'warn', detail: `modes check failed: ${e?.message ?? e}` });
  }

  // 9. Auth posture (PII surface protection).
  const ap = config.authPolicy;
  if (ap.mode === 'open') {
    add({ id: 'auth', label: 'Auth', status: 'pass', detail: 'open (localhost-only bind — frictionless, no token). To expose remotely set MCP_JSA_HOST + MCP_JSA_AUTH_TOKEN.' });
  } else if (ap.mode === 'token') {
    add({ id: 'auth', label: 'Auth', status: 'pass', detail: `bearer token required on /mcp, /files, dashboard ${ap.isLocalhost ? '(localhost + token)' : '(remote bind — PII protected)'}` });
  } else {
    add({ id: 'auth', label: 'Auth', status: 'fail', detail: `DENY — ${ap.reason}`, fix: 'export MCP_JSA_AUTH_TOKEN="$(openssl rand -hex 32)"' });
  }

  // 10. Public base URL (what artifact links use).
  if (config.publicBaseUrlIsExplicit) {
    add({ id: 'public_base_url', label: 'Public URL', status: 'pass',
          detail: `${config.publicBaseUrl} (from MCP_JSA_PUBLIC_BASE_URL)${config.publicBaseUrl !== config.listenUrl ? ` — listen URL is ${config.listenUrl}` : ''}` });
  } else {
    add({ id: 'public_base_url', label: 'Public URL', status: 'pass', detail: `${config.publicBaseUrl} (default — set MCP_JSA_PUBLIC_BASE_URL to override)` });
  }

  // 11. Bind address. At cold start this is just the configured target; in a running server
  // the socket is already bound here (this replaces any "is the port free?" cold-start check).
  add({ id: 'listen', label: ctx === 'server' ? 'Listening on' : 'Bind target', status: 'info',
        detail: ctx === 'server' ? `${config.listenUrl} (server bound)` : config.listenUrl });

  // 12. Career-packet ↔ cv.md sync state.
  try {
    const { getDb } = await import('../db.js');
    getDb();
    const { getActiveCareerPacket, loadProjectFiles, packetStatus } = await import('./profile.js');
    const active = getActiveCareerPacket();
    const status = packetStatus({ active, cvMd: loadProjectFiles().cvMd });
    const v = active ? `v${active.version}` : '';
    switch (status) {
      case 'no_packet':
        add({ id: 'career_packet', label: 'Career packet', status: 'fail', detail: 'no active career_packet', fix: 'npx job_ops-mcp init' });
        break;
      case 'packet_chat_edited':
        add({ id: 'career_packet', label: 'Career packet', status: 'pass',
              detail: `${v} is chat-edited (ahead of cv.md) — expected in chat-driven mode. reseed will NOT overwrite it without force; run sync_packet_to_cv to write edits back, or reseed --force to rebuild from cv.md.` });
        break;
      case 'no_cv':
        add({ id: 'career_packet', label: 'Career packet', status: 'warn', detail: 'cv.md missing — packet is identity-only', fix: 'create cv.md, then reseed' });
        break;
      case 'cv_is_example':
        add({ id: 'career_packet', label: 'Career packet', status: 'warn', detail: 'cv.md is still the example template', fix: 'fill it in, then reseed' });
        break;
      case 'cv_edited_since_seed':
        // Running server: a stale (but working) packet → warning, not a hard failure.
        add({ id: 'career_packet', label: 'Career packet',
              status: ctx === 'server' ? 'warn' : 'fail',
              detail: `${v}: cv.md was edited after the last reseed — the packet is stale.`,
              fix: 'reseed_career_packet (or `npx job_ops-mcp reseed`)' });
        break;
      case 'packet_is_template':
        add({ id: 'career_packet', label: 'Career packet', status: 'warn', detail: `${v} still has TODO markers`, fix: 'reseed' });
        break;
      case 'ok':
        add({ id: 'career_packet', label: 'Career packet', status: 'pass', detail: `${v} matches current cv.md` });
        break;
    }
  } catch {
    add({ id: 'career_packet', label: 'Career packet', status: 'warn', detail: 'check skipped — DB not initialized', fix: 'npx job_ops-mcp init' });
  }

  // ── Tally ──
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) counts[c.status]++;
  const ok = counts.fail === 0;
  const summary = ctx === 'server'
    ? (ok ? `Server healthy — ${counts.pass} ok, ${counts.warn} warning(s).`
          : `${counts.fail} issue(s) need attention (${counts.warn} warning(s)).`)
    : (ok ? 'All required checks passed. Run `npx job_ops-mcp start` to boot.'
          : `${counts.fail} check(s) failed.`);

  return { ok, context: ctx, package: pkgInfo(), counts, checks, summary };
}
