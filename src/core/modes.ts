// Shared loader for the markdown documents in modes/. Cached so chat tools don't
// re-read from disk on every JSON-RPC call. `fs.watch` invalidates the cache when the
// user edits modes/* — no restart required to tune the rubric.
//
// Loader precedence (highest first):
//   1. <projectRoot>/modes/<file>   — user-editable copy scaffolded by `init`
//   2. <installDir>/modes/<file>    — the bundled package default
//
// This lets a user tune the rubric / tailoring rules / outreach tone by editing the
// copy in their project root, while never having to touch the package install. A
// re-`init` never clobbers an edited user copy (init warns instead).
//
// rubric.md gets a small dynamic prefix when `visaScoringEnabled` is false — that single
// injection point ensures every consumer of the rubric (chat-mode evaluate_job step 1,
// api-mode evaluate_job, batch_evaluate, evaluate_training, evaluate_project, the
// `jobops://modes/rubric` MCP resource) sees the override identically.

import { readFileSync, existsSync, watch as fsWatch } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../config.js';

// The behavior-shaping mode files that `init` scaffolds into <projectRoot>/modes/ and
// that the loader resolves with user-over-bundled precedence. Keep in sync with the
// files that actually ship in the package `modes/` directory.
export const MODE_FILES = [
  'tailoring_rules.md',
  'rubric.md',
  'report_format.md',
  'outreach_tone.md',
  'negotiation_playbook.md',
  'career_packet.md',
] as const;

export type ModeSource = 'user' | 'bundled' | 'missing';

const cache = new Map<string, string>();
const watchers: ReturnType<typeof fsWatch>[] = [];
let watchersStarted = false;

function ensureWatcher(): void {
  if (watchersStarted) return;
  watchersStarted = true;
  // Watch BOTH the user dir and the bundled dir so edits to either invalidate the
  // cache. The user dir may not exist yet (project root never `init`-ed) — that's fine.
  for (const dir of [config.userModesDir, config.bundledModesDir]) {
    if (!existsSync(dir)) continue;
    try {
      watchers.push(fsWatch(dir, { persistent: false }, () => cache.clear()));
    } catch {
      // Best-effort — on platforms without fs.watch we just stay cached.
    }
  }
}

const VISA_DISABLED_PREFIX = `# ⚙️ VISA SCORING DISABLED (server config)

The candidate has disabled visa scoring (\`JOBOPS_VISA_SCORING=false\`). For this run:

- **DO NOT** include \`visa_fit\` in the output JSON.
- Use the renormalized formula:
  \`\`\`
  score_total = round(0.6 * resume_fit + 0.4 * taste_fit)
  \`\`\`
- The output contract is now: \`resume_fit\`, \`taste_fit\`, \`score_total\`, \`reasoning\`,
  \`concerns\`, \`role_category\`, \`seniority\`. Omit \`visa_fit\`.
- Ignore the "visa_fit (0–100)" dimension section and the "0.2·visa_fit" term in the
  weighted formula below — they are documentary only.

---

`;

/**
 * Resolve the on-disk path for a mode file, preferring the user-editable copy in
 * <projectRoot>/modes/ over the bundled package default. Returns the path plus
 * which source it came from (`missing` when neither exists).
 */
export function resolveModePath(name: string): { path: string; source: ModeSource } {
  const userPath    = resolve(config.userModesDir, name);
  if (existsSync(userPath))    return { path: userPath,    source: 'user' };
  const bundledPath = resolve(config.bundledModesDir, name);
  if (existsSync(bundledPath)) return { path: bundledPath, source: 'bundled' };
  return { path: bundledPath, source: 'missing' };
}

/** Where a given mode file currently resolves from — used by `doctor`. */
export function modeSource(name: string): ModeSource {
  return resolveModePath(name).source;
}

export function getMode(name: string): string {
  ensureWatcher();
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const { path, source } = resolveModePath(name);
  let body = source !== 'missing' ? readFileSync(path, 'utf-8') : `_missing modes/${name}_`;
  if (name === 'rubric.md' && !config.visaScoringEnabled) {
    body = VISA_DISABLED_PREFIX + body;
  }
  cache.set(name, body);
  return body;
}

export function invalidateModesCache(): void { cache.clear(); }
