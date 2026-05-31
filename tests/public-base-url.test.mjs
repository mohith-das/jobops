// Unit tests for MCP_JSA_PUBLIC_BASE_URL.
//   - resolvePublicBaseUrl(): default / set / trailing-slash / malformed / non-http scheme
//   - fileUrl() / trackerUrl() / mcpUrl(): respect the provided base, strip trailing slash
//
// The full server-level end-to-end check (boot with/without env, hit every link-emitting
// surface, confirm every URL flips) lives in scripts/public-base-url-e2e.mjs — invoked
// from the harness around `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePublicBaseUrl } from '../dist/config.js';
import { fileUrl, trackerUrl, mcpUrl } from '../dist/core/links.js';

const LISTEN = 'http://127.0.0.1:7891';

// ── resolvePublicBaseUrl ────────────────────────────────────────────────────

function withEnv(value, fn) {
  const original = process.env.MCP_JSA_PUBLIC_BASE_URL;
  if (value === null) delete process.env.MCP_JSA_PUBLIC_BASE_URL;
  else process.env.MCP_JSA_PUBLIC_BASE_URL = value;
  try { return fn(); }
  finally {
    if (original === undefined) delete process.env.MCP_JSA_PUBLIC_BASE_URL;
    else process.env.MCP_JSA_PUBLIC_BASE_URL = original;
  }
}

function muteWarnings(fn) {
  const orig = console.error;
  const captured = [];
  console.error = (...args) => { captured.push(args.join(' ')); };
  try { return { result: fn(), warnings: captured }; }
  finally { console.error = orig; }
}

test('default: unset → publicBaseUrl == listenUrl, not explicit', () => {
  withEnv(null, () => {
    const r = resolvePublicBaseUrl(LISTEN);
    assert.equal(r.publicBaseUrl, LISTEN);
    assert.equal(r.publicBaseUrlIsExplicit, false);
  });
});

test('default: empty string → treated as unset', () => {
  withEnv('', () => {
    const r = resolvePublicBaseUrl(LISTEN);
    assert.equal(r.publicBaseUrl, LISTEN);
    assert.equal(r.publicBaseUrlIsExplicit, false);
  });
});

test('set: http URL is used verbatim', () => {
  withEnv('http://my-tailnet:7891', () => {
    const r = resolvePublicBaseUrl(LISTEN);
    assert.equal(r.publicBaseUrl, 'http://my-tailnet:7891');
    assert.equal(r.publicBaseUrlIsExplicit, true);
  });
});

test('set: https URL is used verbatim', () => {
  withEnv('https://jobs.example.ts.net', () => {
    assert.equal(resolvePublicBaseUrl(LISTEN).publicBaseUrl, 'https://jobs.example.ts.net');
  });
});

test('trailing slash is stripped', () => {
  withEnv('http://my-host:7891/', () => {
    assert.equal(resolvePublicBaseUrl(LISTEN).publicBaseUrl, 'http://my-host:7891');
  });
  withEnv('https://example.com///', () => {
    assert.equal(resolvePublicBaseUrl(LISTEN).publicBaseUrl, 'https://example.com');
  });
});

test('IP-with-port works (Tailscale 100.x style)', () => {
  withEnv('http://100.64.0.5:7891', () => {
    assert.equal(resolvePublicBaseUrl(LISTEN).publicBaseUrl, 'http://100.64.0.5:7891');
  });
});

test('malformed value warns + falls back to listenUrl', () => {
  withEnv('not-a-url', () => {
    const { result, warnings } = muteWarnings(() => resolvePublicBaseUrl(LISTEN));
    assert.equal(result.publicBaseUrl, LISTEN);
    assert.equal(result.publicBaseUrlIsExplicit, false);
    assert.ok(warnings.some(w => w.includes('MCP_JSA_PUBLIC_BASE_URL')),
      `expected warning, got: ${warnings.join(' | ')}`);
  });
});

test('non-http(s) scheme warns + falls back', () => {
  withEnv('ftp://example.com', () => {
    const { result, warnings } = muteWarnings(() => resolvePublicBaseUrl(LISTEN));
    assert.equal(result.publicBaseUrl, LISTEN);
    assert.ok(warnings.some(w => w.includes('protocol')), `expected protocol warning, got: ${warnings.join(' | ')}`);
  });
});

// ── Link helpers ────────────────────────────────────────────────────────────

test('fileUrl: explicit base + normal path', () => {
  assert.equal(fileUrl('pdfs/x.pdf', 'http://example.com:9999'), 'http://example.com:9999/files/pdfs/x.pdf');
});

test('fileUrl: strips trailing slash from base', () => {
  assert.equal(fileUrl('pdfs/x.pdf', 'http://example.com:9999/'), 'http://example.com:9999/files/pdfs/x.pdf');
  assert.equal(fileUrl('pdfs/x.pdf', 'http://example.com:9999//'), 'http://example.com:9999/files/pdfs/x.pdf');
});

test('fileUrl: strips leading slash from path (no double slash)', () => {
  assert.equal(fileUrl('/pdfs/x.pdf', 'http://example.com:9999'), 'http://example.com:9999/files/pdfs/x.pdf');
});

test('trackerUrl: ends with single trailing slash', () => {
  assert.equal(trackerUrl('http://example.com:9999'),  'http://example.com:9999/');
  assert.equal(trackerUrl('http://example.com:9999/'), 'http://example.com:9999/');
});

test('mcpUrl: appends /mcp', () => {
  assert.equal(mcpUrl('http://example.com:9999'),  'http://example.com:9999/mcp');
  assert.equal(mcpUrl('http://example.com:9999/'), 'http://example.com:9999/mcp');
});

test('helpers fall back to the module config when base is omitted (smoke)', () => {
  // Whatever the test process inherited from env, just confirm the helpers return a
  // well-formed URL with /files/ in it. The full integration check lives in the e2e
  // script which restarts the server with different envs.
  const u = fileUrl('pdfs/x.pdf');
  assert.match(u, /^https?:\/\/[^/]+\/files\/pdfs\/x\.pdf$/);
});
