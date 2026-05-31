// Google careers provider — Playwright-based.
//
// Google's careers site is a JS SPA. We hit the public search URL and grab job cards.
// Selectors break occasionally; the brief explicitly wants Playwright scrapers for closed
// boards, so we use Playwright and keep the selector list short.
import type { Provider, RawJob, TrackedCompanyEntry } from './types.js';

interface GoogleEntry extends TrackedCompanyEntry {
  google_query?: string;     // e.g. "product manager"
  google_loc?:   string;     // ISO code like "US"
}

const google: Provider = {
  id: 'google',
  detect(entry) {
    if ((entry.provider ?? '') === 'google') return { url: 'https://www.google.com/about/careers/applications/' };
    const careers = entry.careers_url || '';
    return /google\.com\/about\/careers/i.test(careers) ? { url: careers } : null;
  },
  async fetch(entry, ctx): Promise<RawJob[]> {
    if (!ctx.withBrowser) return [];
    const e = entry as GoogleEntry;
    const q = encodeURIComponent(e.google_query ?? 'product manager');
    const loc = e.google_loc ?? 'United States';
    const url = `https://www.google.com/about/careers/applications/jobs/results/?q=${q}&location=${encodeURIComponent(loc)}`;
    return ctx.withBrowser(async (browser) => {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        // Allow ~2s for hydration; the cards appear under <ul.spHGqe> historically.
        await page.waitForTimeout(2_000);
        const items = await page.$$eval('a[href*="/about/careers/applications/jobs/results/"]', (els: any[]) => {
          const seen = new Set<string>();
          return els.map(el => {
            const href = (el as HTMLAnchorElement).href;
            const title = (el.innerText || '').split('\n')[0]?.trim() || '';
            const text  = (el.innerText || '');
            const locMatch = text.match(/\b([A-Z][a-zA-Z]+(?:,\s*[A-Z][A-Z])?(?:;[^]+)?)\b/);
            return { title, href, location: locMatch?.[1] ?? '' };
          }).filter(j => j.title && j.href && j.href.includes('/results/') && !seen.has(j.href) && (seen.add(j.href), true));
        });
        return items.map((j: any) => ({
          title:    j.title,
          url:      j.href,
          company:  entry.name || 'Google',
          location: j.location,
        })) as RawJob[];
      } finally {
        await page.close();
      }
    });
  },
};
export default google;
