// Feature 3: bearer-token auth for the remote / PII surface.
//   Part A — resolveAuthPolicy decision table (pure).
//   Part B — live HTTP: bound to a non-localhost host WITH a token, /files + dashboard are
//            denied without the token and allowed with it; /healthz stays open.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAuthPolicy, isLocalhostHost, bearerFromHeader, tokensMatch } from '../dist/core/auth.js';

// ── Part A: policy decision table ──────────────────────────────────────────────

test('localhost bind, no token → OPEN (frictionless)', () => {
  const p = resolveAuthPolicy({ host: '127.0.0.1', token: null });
  assert.equal(p.mode, 'open');
  assert.equal(p.requireToken, false);
});

test('localhost bind, token set → TOKEN (opt-in even locally)', () => {
  const p = resolveAuthPolicy({ host: '127.0.0.1', token: 'secret' });
  assert.equal(p.mode, 'token');
  assert.equal(p.requireToken, true);
});

test('non-localhost bind, NO token → DENY (default-deny)', () => {
  const p = resolveAuthPolicy({ host: '0.0.0.0', token: null });
  assert.equal(p.mode, 'deny');
  assert.equal(p.requireToken, true);
  assert.match(p.reason, /default-deny/i);
});

test('non-localhost bind, token set → TOKEN (PII protected)', () => {
  const p = resolveAuthPolicy({ host: '0.0.0.0', token: 'secret' });
  assert.equal(p.mode, 'token');
  assert.equal(p.requireToken, true);
});

test('isLocalhostHost recognizes loopback forms; treats LAN/0.0.0.0 as remote', () => {
  for (const h of ['127.0.0.1', '::1', 'localhost', '0.0.0.0', '192.168.1.5']) {
    const local = isLocalhostHost(h);
    if (['127.0.0.1', '::1', 'localhost'].includes(h)) assert.equal(local, true, `${h} should be localhost`);
    else assert.equal(local, false, `${h} should be remote`);
  }
});

test('bearerFromHeader + tokensMatch helpers', () => {
  assert.equal(bearerFromHeader('Bearer abc123'), 'abc123');
  assert.equal(bearerFromHeader('bearer  xyz'), 'xyz');
  assert.equal(bearerFromHeader('Basic abc'), null);
  assert.equal(bearerFromHeader(undefined), null);
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('abc', 'abd'), false);
  assert.equal(tokensMatch('abc', 'abcd'), false);
});

// ── Part B: live HTTP enforcement ──────────────────────────────────────────────

const TOKEN = 'test-token-deadbeef';
let server, baseUrl;

before(async () => {
  // Configure a non-localhost bind WITH a token BEFORE config.ts loads.
  process.env.JOBOPS_HOST = '0.0.0.0';
  process.env.JOBOPS_AUTH_TOKEN = TOKEN;
  process.env.JOBOPS_DATA_DIR = '/tmp/jobops-auth-test-data';
  process.env.JOBOPS_OUTPUT_DIR = '/tmp/jobops-auth-test-out';
  process.env.JOBOPS_PROJECT_ROOT = '/tmp/jobops-auth-test-data';

  const { buildHttpApp } = await import('../dist/http/app.js');
  const app = buildHttpApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

test('policy resolves to token-required for the 0.0.0.0 + token bind', async () => {
  const { config } = await import('../dist/config.js');
  assert.equal(config.authPolicy.mode, 'token');
  assert.equal(config.authPolicy.requireToken, true);
});

test('/healthz is open (no token) — liveness never blocked', async () => {
  const r = await fetch(`${baseUrl}/healthz`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.auth, 'token');
});

test('/files/* WITHOUT a token → 401 (PII denied)', async () => {
  const r = await fetch(`${baseUrl}/files/some-resume.pdf`);
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') ?? '', /Bearer/);
});

test('dashboard / WITHOUT a token → 401', async () => {
  const r = await fetch(`${baseUrl}/`);
  assert.equal(r.status, 401);
});

test('/files/* WITH the bearer token → auth passes (404 for the missing file, not 401)', async () => {
  const r = await fetch(`${baseUrl}/files/definitely-missing.pdf`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.notEqual(r.status, 401, 'valid token must not be rejected');
  assert.equal(r.status, 404, 'auth passed; the missing file 404s');
});

test('/files/* WITH a WRONG token → 401', async () => {
  const r = await fetch(`${baseUrl}/files/x.pdf`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(r.status, 401);
});

test('protected-resource metadata is discoverable unauthenticated', async () => {
  const r = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(r.status, 200);
  const meta = await r.json();
  assert.ok(String(meta.resource).endsWith('/mcp'));
});

// Shared-topology surface: the server-identity endpoint carries the DB path and the
// client list — operator-only detail, same gate as the rest of the PII surface.
test('/api/status WITHOUT a token → 401 (server identity is operator-only)', async () => {
  const r = await fetch(`${baseUrl}/api/status`);
  assert.equal(r.status, 401);
});

test('/api/status WITH the token → full server identity JSON', async () => {
  const r = await fetch(`${baseUrl}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.ok(typeof s.db_path === 'string' && s.db_path.length > 0);
  assert.match(s.db_fingerprint, /^[0-9a-f]{12}$/);
  assert.ok(Array.isArray(s.clients_seen));
});
