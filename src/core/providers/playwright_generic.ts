// Generic Playwright provider for closed boards we don't have an API for.
//
// Configurable via portals.yml:
//   - provider: playwright_generic
//     careers_url: https://...
//     selectors:
//       item:        "a.job-card"            (required — each match → 1 job)
//       title:       ":scope"                (optional — defaults to element text)
//       title_attr:  "data-job-title"        (optional — read from attribute)
//       href_attr:   "href"                  (default "href")
//       location:    ".location-text"        (optional)
//       wait_for:    ".jobs-loaded"          (optional CSS to await)
//       wait_ms:     1500                    (optional fallback delay)
//
// Notion / HuggingFace / Mistral all use Ashby in practice, so they auto-route there.
// This provider is for the long tail.
import type { Provider, RawJob, TrackedCompanyEntry } from './types.js';

interface GenericEntry extends TrackedCompanyEntry {
  selectors?: {
    item:        string;
    title?:      string;
    title_attr?: string;
    href_attr?:  string;
    location?:   string;
    wait_for?:   string;
    wait_ms?:    number;
  };
}

const provider: Provider = {
  id: 'playwright_generic',
  detect(entry) {
    return (entry.provider ?? '') === 'playwright_generic' ? { url: entry.careers_url ?? '' } : null;
  },
  async fetch(entry, ctx): Promise<RawJob[]> {
    const e = entry as GenericEntry;
    if (!e.careers_url) throw new Error(`playwright_generic: careers_url required for ${entry.name}`);
    if (!e.selectors?.item) throw new Error(`playwright_generic: selectors.item required for ${entry.name}`);
    if (!ctx.withBrowser) return [];
    const sel = e.selectors;
    return ctx.withBrowser(async (browser) => {
      const page = await browser.newPage();
      try {
        await page.goto(e.careers_url!, { waitUntil: 'networkidle', timeout: 30_000 });
        if (sel.wait_for) await page.waitForSelector(sel.wait_for, { timeout: 15_000 }).catch(() => undefined);
        else await page.waitForTimeout(sel.wait_ms ?? 1500);
        const items = await page.$$eval(sel.item, (els: any[], cfg: any) => {
          return els.map(el => {
            const a = el.matches?.('a') ? el : el.querySelector?.('a');
            const href = a?.[cfg.href_attr ?? 'href'] ?? a?.getAttribute?.(cfg.href_attr ?? 'href') ?? '';
            const titleEl = cfg.title ? el.querySelector(cfg.title) : el;
            const title = cfg.title_attr
              ? (titleEl?.getAttribute?.(cfg.title_attr) ?? '')
              : (titleEl?.innerText ?? '').trim();
            const locEl  = cfg.location ? el.querySelector(cfg.location) : null;
            const location = locEl ? (locEl.innerText ?? '').trim() : '';
            return { title, href, location };
          });
        }, sel);
        const base = new URL(e.careers_url!);
        return items
          .filter((j: any) => j.title && j.href)
          .map((j: any) => ({
            title:    j.title,
            url:      new URL(j.href, base).toString(),
            company:  entry.name,
            location: j.location,
          })) as RawJob[];
      } finally {
        await page.close();
      }
    });
  },
};
export default provider;
