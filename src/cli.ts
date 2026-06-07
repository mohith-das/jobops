#!/usr/bin/env node
// job_ops-mcp CLI entry point. Subcommands:
//   init    — scaffold cv.md / config/profile.yml / portals.yml from the .example files,
//             run migrations, prompt for project root. Idempotent (never overwrites).
//   start   — boot MCP + HTTP server. Auto-installs Chromium on first run.
//   doctor  — diagnose Node version, Chromium presence, config files, LLM key.
//   connect — print copy-paste config for Claude Desktop + generic MCP clients.

import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(here, '..');         // install root (where dist/, modes/, templates/, examples live)
const PKG = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8'));

// ── arg parser (tiny — no deps) ─────────────────────────────────────────────

function parseArgs(argv: string[]): { cmd: string; flags: Map<string, string | boolean>; positional: string[] } {
  const [, , cmd = 'help', ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const [k, ...vparts] = a.slice(2).split('=');
      const v = vparts.length ? vparts.join('=') : (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true);
      flags.set(k, v);
    } else { positional.push(a); }
  }
  return { cmd, flags, positional };
}

// ── color (tty-aware, no deps) ──────────────────────────────────────────────
const COLOR = process.stdout.isTTY;
const c = {
  bold:  (s: string) => COLOR ? `\x1b[1m${s}\x1b[0m`  : s,
  green: (s: string) => COLOR ? `\x1b[32m${s}\x1b[0m` : s,
  red:   (s: string) => COLOR ? `\x1b[31m${s}\x1b[0m` : s,
  yellow:(s: string) => COLOR ? `\x1b[33m${s}\x1b[0m` : s,
  dim:   (s: string) => COLOR ? `\x1b[2m${s}\x1b[0m`  : s,
};
const tick  = () => COLOR ? c.green('✓') : 'OK ';
const cross = () => COLOR ? c.red('✗')   : 'FAIL ';
const warn  = () => COLOR ? c.yellow('!') : 'WARN ';

// ── init ────────────────────────────────────────────────────────────────────

async function cmdInit(flags: Map<string, string | boolean>) {
  const yes = !!flags.get('yes');
  console.log(c.bold(`\njob_ops-mcp init`));
  console.log(c.dim(`package: ${PKG.name}@${PKG.version}`));
  console.log(c.dim(`install root: ${PACKAGE_ROOT}\n`));

  const cwd = process.cwd();
  console.log(`Project root: ${c.bold(cwd)}`);
  console.log(c.dim('(This is where cv.md, config/profile.yml, portals.yml will live. You can move them later — point the server at the new location with MCP_JSA_PROJECT_ROOT.)\n'));

  const examples: Array<{ src: string; dst: string; label: string }> = [
    { src: 'cv.example.md',                dst: 'cv.md',                  label: 'CV (markdown)' },
    { src: 'config/profile.example.yml',   dst: 'config/profile.yml',     label: 'profile / targeting' },
    { src: 'portals.example.yml',          dst: 'portals.yml',            label: 'tracked portals + filters' },
  ];

  let scaffolded = 0, kept = 0;
  for (const { src, dst, label } of examples) {
    const srcAbs = resolve(PACKAGE_ROOT, src);
    const dstAbs = resolve(cwd, dst);
    if (!existsSync(srcAbs)) { console.log(`  ${cross()} example missing: ${src}`); continue; }
    if (existsSync(dstAbs)) {
      console.log(`  ${warn()} ${dst} already exists — not overwriting (${label})`);
      kept++;
      continue;
    }
    mkdirSync(dirname(dstAbs), { recursive: true });
    copyFileSync(srcAbs, dstAbs);
    console.log(`  ${tick()} scaffolded ${dst} (${label})`);
    scaffolded++;
  }

  // Scaffold the behavior-shaping mode files into <projectRoot>/modes/ so they're
  // user-editable (like cv.md / profile.yml). Idempotent: an existing (likely edited)
  // copy is never overwritten — we warn instead. The loader prefers these over the
  // bundled defaults (see core/modes.ts).
  const { MODE_FILES } = await import('./core/modes.js');
  const modesSrcDir = resolve(PACKAGE_ROOT, 'modes');
  const modesDstDir = resolve(cwd, 'modes');
  console.log('');
  for (const file of MODE_FILES) {
    const srcAbs = resolve(modesSrcDir, file);
    const dstAbs = resolve(modesDstDir, file);
    if (!existsSync(srcAbs)) { console.log(`  ${cross()} bundled mode missing: modes/${file}`); continue; }
    if (existsSync(dstAbs)) {
      console.log(`  ${warn()} modes/${file} already exists — keeping your edits (not overwriting)`);
      kept++;
      continue;
    }
    mkdirSync(modesDstDir, { recursive: true });
    copyFileSync(srcAbs, dstAbs);
    console.log(`  ${tick()} scaffolded modes/${file}`);
    scaffolded++;
  }

  // Run migrations by importing db.ts — getDb() applies pending migrations on first open.
  // Set MCP_JSA_PROJECT_ROOT to cwd BEFORE config.ts gets imported so the data dir lives
  // next to the user's cv.md / profile.yml, not inside the package install.
  process.env.MCP_JSA_PROJECT_ROOT = process.env.MCP_JSA_PROJECT_ROOT || cwd;
  try {
    const { config: cfg } = await import('./config.js');
    const { getDb } = await import('./db.js');
    getDb();
    const {
      ensureActiveCareerPacket, getActiveCareerPacket,
      loadProjectFiles, packetStatus, seedCareerPacketFromFiles,
    } = await import('./core/profile.js');
    const seed = await ensureActiveCareerPacket();
    console.log(`\n  ${tick()} data dir: ${cfg.dataDir}`);
    console.log(`  ${tick()} SQLite migrations applied`);
    console.log(`  ${tick()} career_packet ${seed.created ? 'seeded' : 'present'} (v${seed.version})`);

    // Stale check: cv.md was edited after the last reseed? Rebuild and tell the user
    // clearly. The previous active row is demoted (history retained).
    const status = packetStatus({ active: getActiveCareerPacket(), cvMd: loadProjectFiles().cvMd });
    if (status === 'cv_edited_since_seed') {
      console.log(`  ${warn()} cv.md was edited after the last reseed.`);
      console.log(`  ${c.dim('→ auto-reseeding now (previous active row demoted, version bumped, history kept)…')}`);
      const r = await seedCareerPacketFromFiles({ mode: 'reseed' });
      console.log(`  ${tick()} reseeded → v${r.version} (${r.sections_with_cv_content}/6 sections populated from cv.md)`);
    } else if (status === 'cv_is_example') {
      console.log(`  ${warn()} cv.md still looks like the example template — fill it in, then run ${c.bold('npx job_ops-mcp reseed')}.`);
    } else if (status === 'packet_is_template') {
      console.log(`  ${warn()} active packet still has TODO markers. Run ${c.bold('npx job_ops-mcp reseed')} to rebuild from cv.md.`);
    }
  } catch (e: any) {
    console.log(`  ${cross()} migration error: ${e?.message ?? e}`);
    process.exit(1);
  }

  console.log(c.bold('\nNext steps:'));
  console.log(`  1. Edit ${c.bold('cv.md')}, ${c.bold('config/profile.yml')}, and ${c.bold('portals.yml')} — replace every <TODO> placeholder.`);
  console.log(`     ${c.dim('Optional: tune the behavior in modes/*.md (rubric, tailoring rules, outreach tone) — your edits win over the bundled defaults.')}`);
  console.log(`  2. Run ${c.bold('npx job_ops-mcp doctor')} to confirm everything is wired.`);
  console.log(`  3. Run ${c.bold('npx job_ops-mcp start')} to boot the server.`);
  console.log(`  4. Run ${c.bold('npx job_ops-mcp connect')} for Claude Desktop config.\n`);

  if (scaffolded === 0 && kept > 0) {
    console.log(c.dim('(All example files already present; init is idempotent — re-run safe.)'));
  }
  void yes;  // reserved for future non-interactive prompts
}

// ── start ───────────────────────────────────────────────────────────────────

async function cmdStart(flags: Map<string, string | boolean>) {
  // Default project root = cwd, so users who ran `init` get their files picked up.
  if (!process.env.MCP_JSA_PROJECT_ROOT) process.env.MCP_JSA_PROJECT_ROOT = process.cwd();
  const stdio = !!flags.get('stdio');
  const skipBrowserCheck = !!flags.get('skip-chromium-check');
  // In stdio mode we MUST keep stdout clean — `npx playwright install` writes
  // to stdout and would corrupt the JSON-RPC channel. Force-skip the prompt
  // there and let the user run `doctor` first to confirm Chromium is installed.
  if (!skipBrowserCheck && !stdio) await ensureChromium();
  const { bootServer } = await import('./server.js');
  await bootServer({ stdio });
}

async function ensureChromium(): Promise<void> {
  // Detect a previously-installed Chromium by attempting `playwright.chromium.executablePath()`.
  try {
    const { chromium } = await import('playwright');
    const path = chromium.executablePath();
    if (path && existsSync(path)) return;
  } catch { /* fall through to install */ }
  console.log(c.bold('\n[one-time setup]'));
  console.log('Playwright Chromium not found — downloading now (~150MB, one-time).');
  console.log(c.dim('  $ npx playwright install chromium'));
  const res = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(c.red('Chromium install failed. Run `npx playwright install chromium` manually and re-try.'));
    process.exit(1);
  }
  console.log(c.green('Chromium ready.\n'));
}

// ── doctor ──────────────────────────────────────────────────────────────────

async function cmdDoctor() {
  console.log(c.bold(`\njob_ops-mcp doctor\n`));
  let failures = 0;

  // 1. Node version
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 20) console.log(`  ${tick()} Node ${process.versions.node} (>= 20 required)`);
  else { console.log(`  ${cross()} Node ${process.versions.node} — need >= 20. Install from https://nodejs.org/`); failures++; }

  // 2. Chromium
  let chromiumOk = false;
  try {
    const { chromium } = await import('playwright');
    const p = chromium.executablePath();
    if (p && existsSync(p)) { console.log(`  ${tick()} Playwright Chromium: ${p}`); chromiumOk = true; }
  } catch { /* fall through */ }
  if (!chromiumOk) { console.log(`  ${cross()} Playwright Chromium missing. Fix: ${c.bold('npx playwright install chromium')}`); failures++; }

  // 3. Project root + user config
  const projectRoot = process.env.MCP_JSA_PROJECT_ROOT || process.cwd();
  console.log(`  ${tick()} project root: ${projectRoot}`);
  for (const file of ['cv.md', 'config/profile.yml', 'portals.yml']) {
    const p = resolve(projectRoot, file);
    if (existsSync(p)) {
      const size = statSync(p).size;
      const tooSmall = size < 200;
      if (tooSmall) { console.log(`  ${warn()} ${file} present but suspiciously small (${size} bytes) — did you replace the placeholders?`); }
      else { console.log(`  ${tick()} ${file} (${size} bytes)`); }
    } else {
      console.log(`  ${cross()} ${file} missing. Fix: ${c.bold('npx job_ops-mcp init')}`);
      failures++;
    }
  }

  // 4. LLM key (only required for api / batch paths)
  const provider = (process.env.MCP_JSA_LLM_PROVIDER || 'gemini').toLowerCase();
  const haveKey = (provider === 'gemini' && !!process.env.GEMINI_API_KEY)
               || (provider === 'deepseek' && !!process.env.DEEPSEEK_API_KEY);
  if (haveKey)      console.log(`  ${tick()} LLM provider: ${provider} (key set)`);
  else if (provider === 'none') console.log(`  ${tick()} LLM provider: none (chat-mode only)`);
  else              console.log(`  ${warn()} LLM provider: ${provider} but no API key. chat-mode tools work; api/batch tools will error. Set ${c.bold(provider === 'gemini' ? 'GEMINI_API_KEY' : 'DEEPSEEK_API_KEY')} to enable.`);

  // 5. Visa scoring flag
  const visaOn = (process.env.MCP_JSA_VISA_SCORING ?? 'true').toLowerCase() !== 'false';
  console.log(`  ${tick()} visa scoring: ${visaOn ? 'on (0.5/0.3/0.2)' : 'off (0.6/0.4, visa tools hidden)'}`);

  // 5a. Templates — informational. List bundled + user themes and the active default.
  try {
    const { listThemes, effectiveDefaultTemplate } = await import('./core/templates.js');
    const themes = listThemes();
    const def    = effectiveDefaultTemplate();
    const userCount    = themes.filter(t => t.source === 'user').length;
    const bundledCount = themes.length - userCount;
    const userPart = userCount ? `, ${userCount} user` : '';
    console.log(`  ${tick()} templates: ${bundledCount} bundled${userPart} — default: ${c.bold(def)}`);
    if (process.env.MCP_JSA_DEFAULT_TEMPLATE && process.env.MCP_JSA_DEFAULT_TEMPLATE !== def) {
      console.log(`         ${c.yellow('!')} MCP_JSA_DEFAULT_TEMPLATE="${process.env.MCP_JSA_DEFAULT_TEMPLATE}" not found, falling back to "${def}".`);
    }
    if (!process.env.MCP_JSA_TEMPLATE_DIR) {
      console.log(`         ${c.dim('set MCP_JSA_TEMPLATE_DIR to add a user themes dir — see TEMPLATES.md.')}`);
    }
  } catch (e: any) {
    console.log(`  ${warn()} templates check failed: ${e?.message ?? e}`);
  }

  // 5a-bis. Mode files — report which are user-overridden (project root) vs bundled.
  try {
    const { MODE_FILES, modeSource } = await import('./core/modes.js');
    const sources = MODE_FILES.map(f => ({ f, src: modeSource(f) }));
    const overridden = sources.filter(s => s.src === 'user').map(s => s.f.replace(/\.md$/, ''));
    const missing    = sources.filter(s => s.src === 'missing').map(s => s.f);
    if (missing.length) {
      console.log(`  ${cross()} mode file(s) missing entirely: ${missing.join(', ')} — reinstall the package.`);
      failures++;
    }
    if (overridden.length) {
      const rest = overridden.length < MODE_FILES.length ? '; rest bundled defaults' : '';
      console.log(`  ${tick()} modes: ${overridden.length}/${MODE_FILES.length} user-overridden (${overridden.join(', ')})${rest}`);
    } else {
      console.log(`  ${tick()} modes: all bundled defaults — edit ${c.bold('modes/*.md')} in your project root to customize (init scaffolds them)`);
    }
  } catch (e: any) {
    console.log(`  ${warn()} modes check failed: ${e?.message ?? e}`);
  }

  // 5b. Public base URL — informational, never a failure.
  try {
    const { config: cfg } = await import('./config.js');
    if (cfg.publicBaseUrlIsExplicit) {
      console.log(`  ${tick()} public base URL: ${c.bold(cfg.publicBaseUrl)}  (from MCP_JSA_PUBLIC_BASE_URL)`);
      if (cfg.publicBaseUrl !== cfg.listenUrl) {
        console.log(`         listen URL is ${cfg.listenUrl} — artifact links will use the public URL above.`);
      }
    } else {
      console.log(`  ${tick()} public base URL: ${cfg.publicBaseUrl}  (default — set MCP_JSA_PUBLIC_BASE_URL to override)`);
    }
  } catch { /* config never throws — defensive */ }

  // 6. Career-packet staleness check (only meaningful if the DB exists).
  try {
    const { getDb } = await import('./db.js');
    getDb();
    const { getActiveCareerPacket, loadProjectFiles, packetStatus } =
      await import('./core/profile.js');
    const active = getActiveCareerPacket();
    const status = packetStatus({ active, cvMd: loadProjectFiles().cvMd });
    const fixReseed = c.bold('npx job_ops-mcp reseed');
    const fixInit   = c.bold('npx job_ops-mcp init');
    switch (status) {
      case 'no_packet':
        console.log(`  ${cross()} no active career_packet. Fix: ${fixInit}`);
        failures++;
        break;
      case 'no_cv':
        console.log(`  ${warn()} cv.md missing — packet is identity-only. Fix: create cv.md, then ${fixReseed}.`);
        break;
      case 'cv_is_example':
        console.log(`  ${warn()} cv.md is still the example template. Fill it in, then ${fixReseed}.`);
        break;
      case 'cv_edited_since_seed':
        console.log(`  ${cross()} cv.md was edited after the last reseed. Run ${fixReseed} to refresh.`);
        failures++;
        break;
      case 'packet_is_template':
        console.log(`  ${warn()} career_packet v${active!.version} still has TODO markers. Run ${fixReseed}.`);
        break;
      case 'ok':
        console.log(`  ${tick()} career_packet v${active!.version} matches current cv.md`);
        break;
    }
  } catch {
    console.log(`  ${warn()} career_packet check skipped — DB not initialized (run ${c.bold('npx job_ops-mcp init')} first).`);
  }

  console.log('');
  if (failures > 0) { console.log(c.red(`${failures} check(s) failed.`)); process.exit(1); }
  console.log(c.green('All required checks passed. Run `npx job_ops-mcp start` to boot.\n'));
}

// ── connect ─────────────────────────────────────────────────────────────────

async function cmdConnect(flags: Map<string, string | boolean>) {
  // When MCP_JSA_PUBLIC_BASE_URL is set (remote host / Tailscale), use it for the
  // generic + LibreChat-host config blocks so the URL the user pastes actually
  // reaches the server from another device. Falls back to host:port for local use.
  const port = String(flags.get('port') ?? process.env.MCP_JSA_PORT ?? '7891');
  const host = String(flags.get('host') ?? process.env.MCP_JSA_HOST ?? '127.0.0.1');
  const { config: cfg } = await import('./config.js');
  const url = cfg.publicBaseUrlIsExplicit ? `${cfg.publicBaseUrl}/mcp` : `http://${host}:${port}/mcp`;
  // Host-resolvable from inside a Docker container (LibreChat default deploy shape).
  // host.docker.internal works out-of-the-box on Docker Desktop (macOS/Windows) and on
  // Linux when the compose file sets `extra_hosts: ["host.docker.internal:host-gateway"]`.
  const dockerHost = 'host.docker.internal';
  const dockerUrl  = `http://${dockerHost}:${port}/mcp`;

  console.log(c.bold(`\njob_ops-mcp connect\n`));
  console.log(`Server endpoint: ${c.bold(url)}\n`);

  console.log(c.bold('Generic MCP client (streamable-HTTP, stateless):'));
  console.log(JSON.stringify({
    name:      'job_ops-mcp',
    transport: 'streamable-http',
    url,
  }, null, 2));

  console.log(c.bold('\nClaude Desktop — claude_desktop_config.json (stdio transport):'));
  console.log(c.dim('macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json'));
  console.log(c.dim('Windows: %APPDATA%/Claude/claude_desktop_config.json\n'));
  console.log(c.dim('Claude Desktop only speaks MCP over stdio. The --stdio flag binds MCP to'));
  console.log(c.dim('stdin/stdout; the HTTP file server still runs on the port so /files/* links work.\n'));
  console.log(JSON.stringify({
    mcpServers: {
      'job_ops-mcp': {
        command: 'npx',
        args:    ['-y', PKG.name, 'start', '--stdio'],
        env: {
          MCP_JSA_PORT: port,
          MCP_JSA_HOST: host,
          MCP_JSA_PROJECT_ROOT: process.cwd(),
        },
      },
    },
  }, null, 2));

  // ── LibreChat ────────────────────────────────────────────────────────────
  // LibreChat's MCP transport for HTTP endpoints is `type: streamable-http`
  // (NOT `sse` — that's a separate legacy transport). Add to `librechat.yaml`
  // under `mcpServers:`. Docs: librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers
  console.log(c.bold('\nLibreChat — librechat.yaml (host-process deploy):'));
  console.log(c.dim('Add under top-level `mcpServers:` in your librechat.yaml, then restart LibreChat.\n'));
  console.log(yamlBlock({
    mcpServers: {
      'job_ops-mcp': {
        type:    'streamable-http',
        url,
        timeout: 60000,
      },
    },
  }));

  console.log(c.bold('\nLibreChat in Docker — librechat.yaml + SSRF allowlist:'));
  console.log(c.dim(
    'Inside a container, 127.0.0.1 points at the CONTAINER, not your host. Swap to ' +
    'host.docker.internal (Docker Desktop) or a LAN IP (Linux + extra_hosts).\n' +
    'LibreChat ALSO blocks private/internal addresses by default — you must allowlist ' +
    'them under `mcpSettings.allowedAddresses`. Both blocks below go into librechat.yaml:\n',
  ));
  console.log(yamlBlock({
    mcpServers: {
      'job_ops-mcp': {
        type:    'streamable-http',
        url:     dockerUrl,
        timeout: 60000,
      },
    },
    mcpSettings: {
      allowedAddresses: [`${dockerHost}:${port}`],
    },
  }));
  console.log(c.dim(
    '\nLinux note: if `host.docker.internal` does not resolve, either add\n' +
    '  extra_hosts:\n' +
    '    - "host.docker.internal:host-gateway"\n' +
    'under the LibreChat service in your docker-compose.yml, or swap the URL for your\n' +
    "host's LAN IP and allowlist that IP:port instead.",
  ));

  console.log('');
}

// ── tiny YAML serializer (object → block-style YAML, two-space indent) ──────
// Just enough for `mcpServers` + `mcpSettings.allowedAddresses` shapes — no deps.
function yamlBlock(o: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (o === null || o === undefined) return `${pad}~`;
  if (typeof o === 'string')         return /^[\w./:@#$%^&*()+=,?!{}\[\]-]+$/.test(o) ? o : JSON.stringify(o);
  if (typeof o === 'number' || typeof o === 'boolean') return String(o);
  if (Array.isArray(o)) {
    if (o.length === 0) return '[]';
    return o.map(v => `${pad}- ${yamlBlock(v, indent + 1).replace(/^\s+/, '')}`).join('\n');
  }
  if (typeof o === 'object') {
    const entries = Object.entries(o as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => {
      const isObj = v && typeof v === 'object' && !Array.isArray(v);
      const isArr = Array.isArray(v);
      if (isObj || isArr) {
        const child = yamlBlock(v, indent + 1);
        return `${pad}${k}:\n${child}`;
      }
      return `${pad}${k}: ${yamlBlock(v, indent + 1)}`;
    }).join('\n');
  }
  return JSON.stringify(o);
}

// ── templates ───────────────────────────────────────────────────────────────

async function cmdTemplates() {
  if (!process.env.MCP_JSA_PROJECT_ROOT) process.env.MCP_JSA_PROJECT_ROOT = process.cwd();
  console.log(c.bold('\njob_ops-mcp templates\n'));
  const { config: cfg } = await import('./config.js');
  const { listThemes, effectiveDefaultTemplate } = await import('./core/templates.js');

  const themes  = listThemes();
  const def     = effectiveDefaultTemplate();
  const userDir = cfg.userTemplateDir;

  console.log(c.dim(`default theme: ${c.bold(def)}  ${process.env.MCP_JSA_DEFAULT_TEMPLATE ? '(from MCP_JSA_DEFAULT_TEMPLATE)' : '(built-in default)'}`));
  console.log(c.dim(`bundled themes dir: ${cfg.installDir}/templates/themes`));
  console.log(c.dim(`user themes dir:    ${userDir ?? '(unset — set MCP_JSA_TEMPLATE_DIR to add custom themes)'}\n`));

  if (themes.length === 0) {
    console.log(c.red('No themes found.'));
    return;
  }

  for (const t of themes) {
    const tag       = t.source === 'user' ? c.bold(c.yellow('[user]')) : c.dim('[bundled]');
    const isDefault = t.name === def ? c.green(' (default)') : '';
    const files     = Object.keys(t.files).sort().join(', ');
    console.log(`  ${tag}  ${c.bold(t.name)}${isDefault}`);
    console.log(`           ${c.dim(t.dir)}`);
    console.log(`           ${c.dim(`files: ${files}`)}\n`);
  }

  if (userDir) {
    // Surface any name collision so the user understands which one wins.
    const userNames    = themes.filter(t => t.source === 'user').map(t => t.name);
    const bundledNames = themes.filter(t => t.source === 'bundled').map(t => t.name);
    const shadows = userNames.filter(n => bundledNames.includes(n));
    if (shadows.length) {
      console.log(c.dim(`Note: user theme(s) ${shadows.join(', ')} would shadow a bundled theme of the same name. Listed once above with [user].\n`));
    }
  }
  console.log(c.dim(`Use a theme: pass template="<name>" to render_pdf, or set MCP_JSA_DEFAULT_TEMPLATE.`));
  console.log(c.dim(`Author a new theme: see TEMPLATES.md (placeholder contract).`));
  console.log('');
}

// ── reseed ──────────────────────────────────────────────────────────────────

async function cmdReseed(flags: Map<string, string | boolean>) {
  if (!process.env.MCP_JSA_PROJECT_ROOT) process.env.MCP_JSA_PROJECT_ROOT = process.cwd();
  console.log(c.bold('\njob_ops-mcp reseed\n'));
  console.log(c.dim('Rebuilds the active career_packet from the current cv.md + config/profile.yml.'));
  console.log(c.dim('Bumps version; the previous active row is demoted (history kept).\n'));

  const { loadProjectFiles, cvHasRealContent, seedCareerPacketFromFiles, packetPreview } = await import('./core/profile.js');
  const { cvMd, profile } = loadProjectFiles();

  if (!profile && !flags.get('force')) {
    console.error(`  ${cross()} config/profile.yml not found. Run ${c.bold('npx job_ops-mcp init')} first, or pass --force.`);
    process.exit(1);
  }
  if (!cvHasRealContent(cvMd) && !flags.get('force')) {
    console.error(`  ${warn()} cv.md is missing or looks like the <TODO> example template.`);
    console.error(`  ${c.dim('Fill it in first, then re-run.')}`);
    console.error(`  ${c.dim('Or pass --force to reseed anyway (identity-only — most sections stay as <TODO>).')}`);
    process.exit(1);
  }

  const r = await seedCareerPacketFromFiles({ mode: 'reseed' });
  console.log(`  ${tick()} active career_packet → version ${c.bold(`v${r.version}`)} (${r.bytes} bytes)`);
  console.log(`  ${tick()} ${r.sections_with_cv_content}/6 sections populated from cv.md (sections 3-8)`);
  console.log('');
  console.log(c.dim('Preview (first ~400 chars):'));
  console.log(c.dim('─'.repeat(64)));
  console.log(packetPreview(r.preview, 600));
  console.log(c.dim('─'.repeat(64)));
  console.log('');
}

// ── help ────────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
${c.bold('job_ops-mcp')} — self-hosted MCP server for an end-to-end job search pipeline.

USAGE
  npx job_ops-mcp <command> [flags]

COMMANDS
  init              Scaffold cv.md / config/profile.yml / portals.yml from examples
                    and run SQLite migrations. Idempotent.
  start             Boot the MCP + HTTP server. Auto-installs Chromium on first run.
  start --stdio     Same server, but MCP rides stdin/stdout (for Claude Desktop).
                    HTTP file server still runs on the port so /files/* links work.
  reseed            Rebuild the active career_packet from the current cv.md +
                    config/profile.yml. Run this after editing cv.md.
  templates         List available resume/cover themes (bundled + user dir).
  doctor            Diagnose Node version, Chromium, config files, LLM key.
  connect           Print copy-paste MCP client config (Claude Desktop + LibreChat).
  help              Show this message.

ENV
  MCP_JSA_PORT                 default 7891
  MCP_JSA_HOST                 default 127.0.0.1
  MCP_JSA_PROJECT_ROOT         where cv.md / config/profile.yml / portals.yml live
                               default: current working dir
  MCP_JSA_DATA_DIR             SQLite location; default <install>/data
  MCP_JSA_VISA_SCORING         true | false (default true) — disables visa surface entirely
  MCP_JSA_TEMPLATE_DIR         user-owned dir holding additional themes (overrides bundled)
  MCP_JSA_DEFAULT_TEMPLATE     theme name when render_pdf has no template arg (default "default")
  MCP_JSA_LLM_PROVIDER         gemini | deepseek | none  (api/batch tools only)
  GEMINI_API_KEY / DEEPSEEK_API_KEY

LEARN MORE
  README: ${PKG.homepage || 'https://github.com/<you>/job_ops-mcp'}
`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const { cmd, flags } = parseArgs(process.argv);
  try {
    switch (cmd) {
      case 'init':    await cmdInit(flags);    break;
      case 'start':   await cmdStart(flags);   break;
      case 'doctor':  await cmdDoctor();       break;
      case 'connect': await cmdConnect(flags); break;
      case 'reseed':    await cmdReseed(flags);   break;
      case 'templates': await cmdTemplates();     break;
      case '--version': case '-v': case 'version': console.log(PKG.version); break;
      case 'help':    case '--help': case '-h': default: cmdHelp(); break;
    }
  } catch (e: any) {
    console.error(c.red(`\n[fatal] ${e?.message ?? e}`));
    process.exit(1);
  }
  // Suppress unused-import warning for spawn (reserved for future).
  void spawn; void createInterface; void input; void output;
}

main();
