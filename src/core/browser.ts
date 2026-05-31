// One shared headless Chromium for the whole process. render_pdf, scan providers,
// and apply_prefill all use this — launching Chromium per call is ~300-800ms and
// memory-heavy.

import type { Browser } from 'playwright';

let _browser: Browser | null = null;
let _launching: Promise<Browser> | null = null;

export async function getSharedBrowser(): Promise<Browser> {
  if (_browser) return _browser;
  if (_launching) return _launching;
  _launching = (async () => {
    const { chromium } = await import('playwright');
    const b = await chromium.launch({ headless: true });
    _browser = b;
    _launching = null;
    return b;
  })();
  return _launching;
}

export async function closeSharedBrowser(): Promise<void> {
  if (_browser) { await _browser.close().catch(() => undefined); _browser = null; }
  _launching = null;
}
