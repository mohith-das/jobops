// Shared loader for the markdown documents in modes/. Cached so chat tools don't
// re-read from disk on every JSON-RPC call. `fs.watch` invalidates the cache when the
// user edits modes/* — no restart required to tune the rubric.
//
// rubric.md gets a small dynamic prefix when `visaScoringEnabled` is false — that single
// injection point ensures every consumer of the rubric (chat-mode evaluate_job step 1,
// api-mode evaluate_job, batch_evaluate, evaluate_training, evaluate_project, the
// `mcp-jsa://modes/rubric` MCP resource) sees the override identically.

import { readFileSync, existsSync, watch as fsWatch } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../config.js';

const cache = new Map<string, string>();
let watcher: ReturnType<typeof fsWatch> | null = null;

function ensureWatcher(): void {
  if (watcher || !existsSync(config.modesDir)) return;
  try {
    watcher = fsWatch(config.modesDir, { persistent: false }, () => cache.clear());
  } catch {
    // Best-effort — on platforms without fs.watch we just stay cached.
  }
}

const VISA_DISABLED_PREFIX = `# ⚙️ VISA SCORING DISABLED (server config)

The candidate has disabled visa scoring (\`MCP_JSA_VISA_SCORING=false\`). For this run:

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

export function getMode(name: string): string {
  ensureWatcher();
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const path = resolve(config.modesDir, name);
  let body = existsSync(path) ? readFileSync(path, 'utf-8') : `_missing modes/${name}_`;
  if (name === 'rubric.md' && !config.visaScoringEnabled) {
    body = VISA_DISABLED_PREFIX + body;
  }
  cache.set(name, body);
  return body;
}

export function invalidateModesCache(): void { cache.clear(); }
