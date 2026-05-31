// Job-description fetcher / normalizer.
//
// chat-mode evaluate_job accepts either:
//   - a URL → we fetch HTML, strip tags, return plain-text JD
//   - pasted JD text → we just trim + cap length
//
// We intentionally keep this dumb: the chat client is the reasoning layer. We hand it
// a clean text blob, not a parsed JD object. Greenhouse / Ashby fetchers in milestone 2
// will reuse the same shape for `scan_portals`.

const FETCH_TIMEOUT_MS = 12_000;
const MAX_JD_CHARS     = 18_000;
const USER_AGENT       = 'Mozilla/5.0 (compatible; mcp-jsa/0.1)';

/**
 * Best-effort extraction of the company name from a known ATS URL. Returns a
 * Title-Cased company name when the URL matches a recognised host, else null.
 * Exported for tests + direct use in adoptJobFromJD.
 *
 *   greenhouse:      https://(job-boards|boards|job-boards.eu).greenhouse.io/<slug>
 *   ashby:           https://jobs.ashbyhq.com/<slug>
 *   lever:           https://jobs.lever.co/<slug>
 *   workday:         https://<tenant>.wd<N>.myworkdayjobs.com/<site>
 *   amazon:          https://*.amazon.jobs/*  → "Amazon"
 *   google careers:  https://www.google.com/about/careers/* → "Google"
 */
export function extractCompanyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  if (/(?:^|\.)greenhouse\.io$/.test(host)) {
    const m = path.match(/^\/([^/]+)/);
    if (m) return titleCaseSlug(m[1]);
  }
  if (host === 'jobs.ashbyhq.com') {
    const m = path.match(/^\/([^/]+)/);
    if (m) return titleCaseSlug(m[1]);
  }
  if (host === 'jobs.lever.co') {
    const m = path.match(/^\/([^/]+)/);
    if (m) return titleCaseSlug(m[1]);
  }
  const wd = host.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (wd) return titleCaseSlug(wd[1]);
  if (host === 'www.amazon.jobs' || host === 'amazon.jobs') return 'Amazon';
  if (host === 'www.google.com' && /^\/about\/careers/.test(path)) return 'Google';
  return null;
}

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export interface NormalizedJD {
  source:      'url' | 'paste';
  source_url:  string | null;
  title_guess: string | null;
  company_guess: string | null;
  text:        string;            // cleaned text body, capped
  raw_html:    string | null;     // present only when source=url, for debugging
  fetched_at:  string;            // ISO timestamp
}

export async function normalizeJD(input: string): Promise<NormalizedJD> {
  const trimmed = input.trim();
  if (looksLikeUrl(trimmed)) {
    return fetchFromUrl(trimmed);
  }
  return {
    source: 'paste',
    source_url: null,
    title_guess: null,
    company_guess: null,
    text: trimmed.slice(0, MAX_JD_CHARS),
    raw_html: null,
    fetched_at: new Date().toISOString(),
  };
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) && s.length < 4096 && !s.includes('\n');
}

async function fetchFromUrl(url: string): Promise<NormalizedJD> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, 'accept': 'text/html,application/xhtml+xml' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const html = await res.text();
    const title   = extractTag(html, 'title');
    const ogSite  = extractMeta(html, 'og:site_name');
    const ogTitle = extractMeta(html, 'og:title');
    const text    = htmlToPlainText(html);
    // URL-derived company is authoritative for known ATS hosts. og:site_name on those
    // hosts is often the ATS vendor ("Greenhouse"), not the hiring company, so prefer
    // the slug. Fall back to OG site_name for unknown hosts.
    const company_guess = extractCompanyFromUrl(url) ?? ogSite ?? null;
    return {
      source: 'url',
      source_url: url,
      title_guess: ogTitle ?? title ?? null,
      company_guess,
      text: text.slice(0, MAX_JD_CHARS),
      raw_html: html.slice(0, MAX_JD_CHARS * 2),
      fetched_at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractTag(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(stripTags(m[1])).trim() : null;
}

function extractMeta(html: string, property: string): string | null {
  // Match BOTH <meta property="X" content="Y"> and <meta name="X" content="Y"> in either order.
  const re = new RegExp(
    `<meta\\b[^>]*?(?:property|name)=["']${property.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}["'][^>]*?content=["']([^"']*)["']`,
    'i',
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : null;
}

function htmlToPlainText(html: string): string {
  // Drop script/style entirely; convert block-ish tags to newlines; strip the rest.
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi,   ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|section|article|header|footer|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}
