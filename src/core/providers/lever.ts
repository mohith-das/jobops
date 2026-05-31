// Lever postings API. Ported from career-ops/providers/lever.mjs.
import type { Provider, RawJob, TrackedCompanyEntry } from './types.js';

function resolveApi(entry: TrackedCompanyEntry): string | null {
  if (entry.lever_slug) return `https://api.lever.co/v0/postings/${entry.lever_slug}`;
  const url = entry.careers_url || '';
  const m = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (!m) return null;
  return `https://api.lever.co/v0/postings/${m[1]}`;
}

const lever: Provider = {
  id: 'lever',
  detect(entry) {
    const url = resolveApi(entry);
    return url ? { url } : null;
  },
  async fetch(entry, ctx): Promise<RawJob[]> {
    const url = resolveApi(entry);
    if (!url) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    const json = await ctx.fetchJson(url);
    if (!Array.isArray(json)) return [];
    return json.map((j: any) => ({
      title:    j.text || '',
      url:      j.hostedUrl || '',
      company:  entry.name,
      location: j.categories?.location || '',
    }));
  },
};
export default lever;
