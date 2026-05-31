// Centralized config — every other module imports from here so env-var changes are obvious.
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = resolve(here, '..'); // dist/ → install root

function abs(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export interface AppConfig {
  installDir:   string;
  projectRoot:  string;   // where cv.md, config/profile.yml, portals.yml live
  dataDir:      string;
  outputDir:    string;
  modesDir:     string;
  templatesDir: string;
  fontsDir:     string;
  dbPath:       string;
  port:         number;
  host:         string;
  /**
   * Where this process actually binds. ALWAYS http://${host}:${port}. Used by the
   * boot banner and `app.listen()`. NOT used to construct artifact links — that's
   * `publicBaseUrl`.
   */
  listenUrl:    string;
  /**
   * The URL emitted in every artifact link (resume / cover / report / tracker /
   * apply_prefill screenshot). Defaults to `listenUrl` when MCP_JSA_PUBLIC_BASE_URL
   * is unset, so behaviour is unchanged for local-only users. When set, every link
   * uses the provided URL instead of 127.0.0.1 — fixes the case where the server
   * runs on a remote host (e.g. over Tailscale) and links need to be reachable
   * from other devices.
   */
  publicBaseUrl: string;
  /** True when MCP_JSA_PUBLIC_BASE_URL was explicitly set + parsed OK. */
  publicBaseUrlIsExplicit: boolean;
  /**
   * Legacy alias kept so any caller that imported `config.baseUrl` keeps working.
   * Mirrors `publicBaseUrl`. New code should use the link helpers in
   * `core/links.ts` (`fileUrl`, `trackerUrl`) rather than reading this directly.
   */
  baseUrl:      string;
  schedulerEnabled: boolean;
  llmProvider:  string;
  llmModel:     string | null;
  /**
   * When true (default), evaluators score visa_fit and the formula is
   *   round(0.5 * resume + 0.3 * taste + 0.2 * visa).
   * When false, visa_fit is dropped from the rubric, weights renormalize to
   *   round(0.6 * resume + 0.4 * taste), the visa_* tools are hidden from
   *   tools/list, and visa columns are stripped from tool responses.
   * Useful for users who don't need visa signal (US citizens / non-US users / etc.).
   */
  visaScoringEnabled: boolean;
}

export function loadConfig(): AppConfig {
  const installDir  = INSTALL_DIR;
  // Project root defaults to CWD, NOT installDir — for npx users this means cv.md,
  // profile.yml, portals.yml, the SQLite DB, and output/ all live next to each other
  // in the user's working directory. installDir stays read-only.
  const projectRoot = process.env.MCP_JSA_PROJECT_ROOT
    ? abs(process.env.MCP_JSA_PROJECT_ROOT, process.cwd())
    : process.cwd();
  const dataDir   = abs(process.env.MCP_JSA_DATA_DIR   || './data',   projectRoot);
  const outputDir = abs(process.env.MCP_JSA_OUTPUT_DIR || './output', projectRoot);
  // modes/templates/fonts ship with the package — always read from installDir.
  const modesDir     = resolve(installDir, 'modes');
  const templatesDir = resolve(installDir, 'templates');
  const fontsDir     = resolve(installDir, 'fonts');
  const dbPath = resolve(dataDir, 'mcp-jsa.db');

  for (const dir of [dataDir, outputDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const host = process.env.MCP_JSA_HOST || '127.0.0.1';
  const port = envNum('MCP_JSA_PORT', 7891);
  const listenUrl = `http://${host}:${port}`;
  const { publicBaseUrl, publicBaseUrlIsExplicit } = resolvePublicBaseUrl(listenUrl);

  return {
    installDir,
    projectRoot,
    dataDir,
    outputDir,
    modesDir,
    templatesDir,
    fontsDir,
    dbPath,
    port,
    host,
    listenUrl,
    publicBaseUrl,
    publicBaseUrlIsExplicit,
    baseUrl: publicBaseUrl,   // back-compat alias
    schedulerEnabled:   envBool('MCP_JSA_SCHEDULER_ENABLED', false),
    llmProvider:        process.env.MCP_JSA_LLM_PROVIDER || 'none',
    llmModel:           process.env.MCP_JSA_LLM_MODEL || null,
    visaScoringEnabled: envBool('MCP_JSA_VISA_SCORING', true),
  };
}

/**
 * Validate + normalize MCP_JSA_PUBLIC_BASE_URL. Falls back to listenUrl on any
 * malformed input (with a stderr warning). Strips trailing slashes.
 *
 * Exported so the unit tests can hit it without booting the server.
 */
export function resolvePublicBaseUrl(listenUrl: string): { publicBaseUrl: string; publicBaseUrlIsExplicit: boolean } {
  const raw = process.env.MCP_JSA_PUBLIC_BASE_URL?.trim();
  if (!raw) return { publicBaseUrl: listenUrl, publicBaseUrlIsExplicit: false };
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch {
    // eslint-disable-next-line no-console
    console.error(`[config] WARN: MCP_JSA_PUBLIC_BASE_URL "${raw}" is not a well-formed URL — falling back to ${listenUrl}. Set it to e.g. "http://my-host:7891" or "https://jobs.example.ts.net".`);
    return { publicBaseUrl: listenUrl, publicBaseUrlIsExplicit: false };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // eslint-disable-next-line no-console
    console.error(`[config] WARN: MCP_JSA_PUBLIC_BASE_URL "${raw}" uses protocol "${parsed.protocol}" — only http: and https: are supported. Falling back to ${listenUrl}.`);
    return { publicBaseUrl: listenUrl, publicBaseUrlIsExplicit: false };
  }
  // Reconstruct origin + optional pathname, stripping trailing slash. Drop any
  // query/hash since the server emits paths under /files/ etc.
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const cleaned  = `${parsed.protocol}//${parsed.host}${pathname}`;
  return { publicBaseUrl: cleaned, publicBaseUrlIsExplicit: true };
}

export const config = loadConfig();
