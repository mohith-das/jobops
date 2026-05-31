// Greenhouse boards API. Ported from career-ops/providers/greenhouse.mjs.
import type { Provider, RawJob, TrackedCompanyEntry } from './types.js';

const ALLOWED_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

function assertHost(url: string): string {
  const p = new URL(url);
  if (p.protocol !== 'https:') throw new Error(`greenhouse: must be HTTPS: ${url}`);
  if (!ALLOWED_HOSTS.has(p.hostname)) {
    throw new Error(`greenhouse: untrusted host ${p.hostname}`);
  }
  return url;
}

function resolveApi(entry: TrackedCompanyEntry): string | null {
  if (entry.api) { try { return assertHost(entry.api); } catch { return null; } }
  if (entry.greenhouse_slug) return `https://boards-api.greenhouse.io/v1/boards/${entry.greenhouse_slug}/jobs`;
  const url = entry.careers_url || '';
  const m = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (m) return `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs`;
  return null;
}

const greenhouse: Provider = {
  id: 'greenhouse',
  detect(entry) {
    const url = resolveApi(entry);
    return url ? { url } : null;
  },
  async fetch(entry, ctx): Promise<RawJob[]> {
    const url = resolveApi(entry);
    if (!url) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertHost(url);
    const json = await ctx.fetchJson(url, { redirect: 'error' });
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.filter((j: any) => j.absolute_url).map((j: any) => ({
      title:    j.title || '',
      url:      j.absolute_url,
      company:  entry.name,
      location: j.location?.name || '',
    }));
  },
};
export default greenhouse;
