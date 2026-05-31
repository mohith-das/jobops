// Ashby posting API. Ported from career-ops/providers/ashby.mjs.
import type { Provider, RawJob, TrackedCompanyEntry } from './types.js';

function resolveApi(entry: TrackedCompanyEntry): string | null {
  if (entry.ashby_slug) return `https://api.ashbyhq.com/posting-api/job-board/${entry.ashby_slug}?includeCompensation=true`;
  const url = entry.careers_url || '';
  const m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (!m) return null;
  return `https://api.ashbyhq.com/posting-api/job-board/${m[1]}?includeCompensation=true`;
}

const ashby: Provider = {
  id: 'ashby',
  detect(entry) {
    const url = resolveApi(entry);
    return url ? { url } : null;
  },
  async fetch(entry, ctx): Promise<RawJob[]> {
    const url = resolveApi(entry);
    if (!url) throw new Error(`ashby: cannot derive API URL for ${entry.name}`);
    const json = await ctx.fetchJson(url);
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.map((j: any) => ({
      title:    j.title || '',
      url:      j.jobUrl || '',
      company:  entry.name,
      location: j.location || '',
    }));
  },
};
export default ashby;
