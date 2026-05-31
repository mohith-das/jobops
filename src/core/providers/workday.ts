// Workday provider.
//
// Workday tenants expose a public JSON endpoint under each careers site:
//   POST https://{tenant}.{site}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//   body: { appliedFacets: {}, limit, offset, searchText: "" }
//
// We auto-derive {tenant} and {site} from the `workday_url` field on the company entry.
// No Playwright required for the JSON path; the Workday HTML page is JS-heavy, but the
// internal JSON endpoint is the same one their SPA hits.
import type { Provider, RawJob, TrackedCompanyEntry } from './types.js';

function resolveEndpoints(entry: TrackedCompanyEntry):
  { url: string; tenant: string; site: string; origin: string; pageBase: string } | null {
  const candidate = entry.workday_url || entry.careers_url || '';
  // Patterns we accept:
  //   https://acme.wd5.myworkdayjobs.com/external_career_site
  //   https://acme.wd5.myworkdayjobs.com/en-US/external_career_site
  const m = candidate.match(/^(https?:\/\/([^.]+)\.wd\d+\.myworkdayjobs\.com)\/(?:[^/]+\/)?([^/?#]+)/i);
  if (!m) return null;
  const origin = m[1];
  const tenant = m[2];
  const site   = m[4];
  return {
    url:      `${origin}/wday/cxs/${tenant}/${site}/jobs`,
    tenant, site, origin,
    pageBase: `${origin}/${site}/job`,
  };
}

const workday: Provider = {
  id: 'workday',
  detect(entry) {
    const r = resolveEndpoints(entry);
    return r ? { url: r.url } : null;
  },
  async fetch(entry, ctx): Promise<RawJob[]> {
    const r = resolveEndpoints(entry);
    if (!r) throw new Error(`workday: cannot derive endpoints for ${entry.name}`);
    const body = JSON.stringify({ appliedFacets: {}, limit: 50, offset: 0, searchText: '' });
    const json = await ctx.fetchJson(r.url, {
      method:  'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    });
    const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
    return postings.map((j: any) => ({
      title:    j.title || '',
      url:      j.externalPath ? `${r.origin}${j.externalPath}` : (j.externalUrl || ''),
      company:  entry.name,
      location: j.locationsText || '',
    })).filter((j: RawJob) => j.url);
  },
};
export default workday;
