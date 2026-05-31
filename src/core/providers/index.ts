// Provider registry. Explicit imports so the build is deterministic and the IDE shows
// provider sources at a glance.

import type { Provider, ProviderCtx, TrackedCompanyEntry } from './types.js';
import { fetchJson, fetchText } from './http.js';
import { getSharedBrowser, closeSharedBrowser } from '../browser.js';

import greenhouse        from './greenhouse.js';
import ashby             from './ashby.js';
import lever             from './lever.js';
import workday           from './workday.js';
import amazon            from './amazon.js';
import google            from './google.js';
import playwrightGeneric from './playwright_generic.js';

export const PROVIDERS: Map<string, Provider> = new Map([
  // Order matters for detect() fallback chain — most specific first (insertion order =
  // detect-priority). Greenhouse/Ashby/Lever are the most specific (exact host match);
  // Workday matches a tenant URL pattern; Amazon matches a domain substring; Google is
  // hostname-based; playwright_generic only runs when explicitly opted-in.
  greenhouse,
  ashby,
  lever,
  workday,
  amazon,
  google,
  playwrightGeneric,
].map(p => [p.id, p] as const));

export interface ResolveOptions {
  skip?: Set<string>;
}

export function resolveProvider(entry: TrackedCompanyEntry, opts: ResolveOptions = {}): Provider | null {
  if (entry.provider) {
    const p = PROVIDERS.get(entry.provider);
    if (!p) return null;
    return p;
  }
  for (const p of PROVIDERS.values()) {
    if (opts.skip?.has(p.id)) continue;
    try {
      if (p.detect?.(entry)) return p;
    } catch { /* ignore detect failures */ }
  }
  return null;
}

// The process-wide Chromium lives in core/browser.ts; render_pdf, apply_prefill, and
// closed-board providers all share it.
export async function closeProviderBrowser(): Promise<void> { await closeSharedBrowser(); }

export function makeProviderCtx(): ProviderCtx {
  return {
    fetchJson,
    fetchText,
    withBrowser: async (fn) => fn(await getSharedBrowser()),
  };
}
