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
    return {
      source: 'url',
      source_url: url,
      title_guess: ogTitle ?? title ?? null,
      company_guess: ogSite ?? null,
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
