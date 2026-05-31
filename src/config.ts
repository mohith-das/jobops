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
  baseUrl:      string;   // http://host:port — embedded in every returned link
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
    baseUrl: `http://${host}:${port}`,
    schedulerEnabled:   envBool('MCP_JSA_SCHEDULER_ENABLED', false),
    llmProvider:        process.env.MCP_JSA_LLM_PROVIDER || 'none',
    llmModel:           process.env.MCP_JSA_LLM_MODEL || null,
    visaScoringEnabled: envBool('MCP_JSA_VISA_SCORING', true),
  };
}

export const config = loadConfig();
