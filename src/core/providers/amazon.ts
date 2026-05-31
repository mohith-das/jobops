// Amazon Jobs provider.
//
// amazon.jobs ships a JSON endpoint at /en/search.json. Free-form `base_query` in the
// company entry lets you target a specific team (e.g. base_query=AGI). No Playwright
// required; we keep this as an explicit `provider: amazon` opt-in in portals.yml.
import type { Provider, RawJob, TrackedCompanyEntry } from './types.js';

interface AmazonEntry extends TrackedCompanyEntry {
  amazon_base_query?: string;   // e.g. "AGI"
  amazon_limit?:      number;
}

const amazon: Provider = {
  id: 'amazon',
  detect(entry) {
    if ((entry.provider ?? '') === 'amazon') return { url: 'https://www.amazon.jobs/en/search.json' };
    const careers = entry.careers_url || '';
    return careers.includes('amazon.jobs') ? { url: 'https://www.amazon.jobs/en/search.json' } : null;
  },
  async fetch(entry, ctx): Promise<RawJob[]> {
    const e = entry as AmazonEntry;
    const params = new URLSearchParams({
      'normalized_country_code[]': 'USA',
      'radius':       '24km',
      'industry_experience': 'less_than_1_year',
      'sort':         'recent',
      'result_limit': String(e.amazon_limit ?? 50),
      'offset':       '0',
      'business_category[]': '',
    });
    if (e.amazon_base_query) params.set('base_query', e.amazon_base_query);
    const url = `https://www.amazon.jobs/en/search.json?${params.toString()}`;
    const json = await ctx.fetchJson(url, { headers: { 'accept': 'application/json' } });
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.map((j: any) => ({
      title:    j.title || '',
      url:      j.url_next_step
                 ? `https://www.amazon.jobs${j.url_next_step}`
                 : (j.job_path ? `https://www.amazon.jobs${j.job_path}` : ''),
      company:  entry.name || 'Amazon',
      location: j.normalized_location || j.location || '',
    })).filter((j: RawJob) => j.url);
  },
};
export default amazon;
