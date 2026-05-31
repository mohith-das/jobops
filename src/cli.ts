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

  // Run migrations by importing db.ts — getDb() applies pending migrations on first open.
  // Set MCP_JSA_PROJECT_ROOT to cwd BEFORE config.ts gets imported so the data dir lives
  // next to the user's cv.md / profile.yml, not inside the package install.
  process.env.MCP_JSA_PROJECT_ROOT = process.env.MCP_JSA_PROJECT_ROOT || cwd;
  try {
    const { config: cfg } = await import('./config.js');
    const { getDb } = await import('./db.js');
    getDb();
    const { ensureActiveCareerPacket } = await import('./core/profile.js');
    const seed = ensureActiveCareerPacket();
    console.log(`\n  ${tick()} data dir: ${cfg.dataDir}`);
    console.log(`  ${tick()} SQLite migrations applied`);
    console.log(`  ${tick()} career_packet ${seed.created ? 'seeded' : 'present'} (v${seed.version})`);
  } catch (e: any) {
    console.log(`  ${cross()} migration error: ${e?.message ?? e}`);
    process.exit(1);
  }

  console.log(c.bold('\nNext steps:'));
  console.log(`  1. Edit ${c.bold('cv.md')}, ${c.bold('config/profile.yml')}, and ${c.bold('portals.yml')} — replace every <TODO> placeholder.`);
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
  const skipBrowserCheck = !!flags.get('skip-chromium-check');
  if (!skipBrowserCheck) await ensureChromium();
  await import('./server.js');
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

  console.log('');
  if (failures > 0) { console.log(c.red(`${failures} check(s) failed.`)); process.exit(1); }
  console.log(c.green('All required checks passed. Run `npx job_ops-mcp start` to boot.\n'));
}

// ── connect ─────────────────────────────────────────────────────────────────

async function cmdConnect(flags: Map<string, string | boolean>) {
  const port = String(flags.get('port') ?? process.env.MCP_JSA_PORT ?? '7891');
  const host = String(flags.get('host') ?? process.env.MCP_JSA_HOST ?? '127.0.0.1');
  const url = `http://${host}:${port}/mcp`;
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

  console.log(c.bold('\nClaude Desktop — claude_desktop_config.json:'));
  console.log(c.dim('macOS: ~/Library/Application Support/Claude/claude_desktop_config.json'));
  console.log(c.dim('Windows: %APPDATA%/Claude/claude_desktop_config.json\n'));
  console.log(JSON.stringify({
    mcpServers: {
      'job_ops-mcp': {
        command: 'npx',
        args:    ['-y', PKG.name, 'start'],
        env: {
          MCP_JSA_PORT: port,
          MCP_JSA_HOST: host,
          MCP_JSA_PROJECT_ROOT: process.cwd(),
        },
      },
    },
  }, null, 2));

  console.log(c.bold('\nClaude Desktop — manual streamable-HTTP (if the npx form is unsupported):'));
  console.log(c.dim('First boot the server in a separate terminal: `npx job_ops-mcp start`, then:'));
  console.log(JSON.stringify({
    mcpServers: {
      'job_ops-mcp': { transport: { type: 'streamable-http', url } },
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
  doctor            Diagnose Node version, Chromium, config files, LLM key.
  connect           Print copy-paste MCP client config (Claude Desktop + generic).
  help              Show this message.

ENV
  MCP_JSA_PORT                 default 7891
  MCP_JSA_HOST                 default 127.0.0.1
  MCP_JSA_PROJECT_ROOT         where cv.md / config/profile.yml / portals.yml live
                               default: current working dir
  MCP_JSA_DATA_DIR             SQLite location; default <install>/data
  MCP_JSA_VISA_SCORING         true | false (default true) — disables visa surface entirely
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
