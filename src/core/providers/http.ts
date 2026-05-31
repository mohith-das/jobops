// HTTP transport for providers (ported from career-ops/providers/_http.mjs).
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; mcp-jsa/0.2)';

export async function fetchWithTimeout(url: string, opts: any = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method:  opts.method  ?? 'GET',
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...opts.headers },
      body:    opts.body,
      redirect: opts.redirect ?? 'follow',
      signal:  controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const snip = text.replace(/\s+/g, ' ').trim().slice(0, 300);
      const err: any = new Error(snip ? `HTTP ${res.status}: ${snip}` : `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url: string, opts: any = {}): Promise<any> {
  const res = await fetchWithTimeout(url, opts);
  return res.json();
}

export async function fetchText(url: string, opts: any = {}): Promise<string> {
  const res = await fetchWithTimeout(url, opts);
  return res.text();
}
