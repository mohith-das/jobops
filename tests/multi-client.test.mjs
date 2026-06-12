// "One shared server, many clients" — the multi-client topology tests.
//   A. Two simulated MCP clients against ONE HTTP server both see the same data;
//      a write from client A is immediately visible to client B.
//   B. Concurrent writes from many clients are serialized (write lock) — nothing
//      lost, nothing corrupted.
//   C. Concurrent requests get THEIR OWN responses (fresh server per request —
//      no cross-routing between overlapping clients).
//   D. /api/status reports the shared source-of-truth DB + clients seen, so a
//      user can verify all clients hit the same instance.
//
// One Express app on one ephemeral port serves every "client" here — exactly the
// production shape of `npx job_ops-mcp start` (no per-client spawn, no EADDRINUSE).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let sandbox, server, baseUrl;

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-multiclient-'));
  mkdirSync(resolve(sandbox, 'config'), { recursive: true });
  writeFileSync(resolve(sandbox, 'cv.md'), `# CV — Casey Riley
**Email:** casey@example.com

## Professional Summary
Builder PM.

## Work Experience
### Vellum — Product Manager
Remote · 2024 – Present
- Owned the agentic workflows surface
`);
  writeFileSync(resolve(sandbox, 'config/profile.yml'), `candidate:\n  full_name: "Casey Riley"\n  email: "casey@example.com"\n`);
  writeFileSync(resolve(sandbox, 'portals.yml'), `tracked_companies: []\n`);

  process.env.MCP_JSA_DATA_DIR     = resolve(sandbox, 'data');
  process.env.MCP_JSA_OUTPUT_DIR   = resolve(sandbox, 'output');
  process.env.MCP_JSA_PROJECT_ROOT = sandbox;
  delete process.env.MCP_JSA_AUTH_TOKEN;
  delete process.env.MCP_JSA_HOST;

  const { getDb } = await import('../dist/db.js');
  getDb();
  const { buildHttpApp } = await import('../dist/http/app.js');
  const { mountMcp } = await import('../dist/mcp/server.js');
  const app = buildHttpApp();
  mountMcp(app, '/mcp');
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

// ── Tiny MCP-over-HTTP client (stateless streamable-HTTP, JSON responses) ──

let rpcId = 100;
async function rpc(method, params, { id } = {}) {
  const reqId = id ?? ++rpcId;
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }),
  });
  assert.equal(r.status, 200, `${method} should 200 (got ${r.status})`);
  const body = await r.json();
  return { reqId, body };
}

function mcpClient(name) {
  return {
    name,
    initialize: () => rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name, version: '1.0.0' },
    }),
    callTool: async (toolName, args, opts) => {
      const { reqId, body } = await rpc('tools/call', { name: toolName, arguments: args }, opts);
      assert.equal(body.id, reqId, 'response id must match the request id');
      assert.ok(!body.error, `tools/call ${toolName} errored: ${JSON.stringify(body.error)}`);
      const text = body.result?.content?.[0]?.text ?? '{}';
      return { reqId, body, payload: JSON.parse(text), isError: body.result?.isError };
    },
  };
}

async function seedJob(title) {
  const { upsertJob } = await import('../dist/core/jobs.js');
  const r = await upsertJob({ source: 'test', source_url: `test://${title}`, company_name: 'Vellum', title });
  return r.id;
}

// ── A. Shared state across clients ──────────────────────────────────────────

test('two clients on one server: a write from client A is visible to client B', async () => {
  const clientA = mcpClient('client-a-claude-code');
  const clientB = mcpClient('client-b-opencode');
  await clientA.initialize();
  await clientB.initialize();

  const jobId = await seedJob('Builder PM');

  // Client A moves the job; client B reads the tracker.
  const w = await clientA.callTool('update_status', { job_id: jobId, status: 'ready_to_apply' });
  assert.ok(!w.isError, `update_status failed: ${JSON.stringify(w.payload)}`);

  const r = await clientB.callTool('get_tracker', { q: 'Builder PM' });
  const item = (r.payload.items ?? []).find((i) => i.job_id === jobId || i.id === jobId);
  assert.ok(item, `client B must see the job (got ${JSON.stringify(r.payload).slice(0, 300)})`);
  assert.equal(item.status, 'ready_to_apply', 'client B must see client A\'s status change');
});

// ── B. Concurrent writes are serialized, none lost ──────────────────────────

test('10 concurrent writers from different clients: all writes land, none corrupt', async () => {
  const writers = Array.from({ length: 10 }, (_, i) => mcpClient(`writer-${i}`));
  await Promise.all(writers.map((w) => w.initialize()));

  const results = await Promise.all(writers.map((w, i) =>
    w.callTool('add_contacts', {
      contacts: [{ full_name: `Concurrent Contact ${i}`, company: `Co ${i}`, position: 'Engineer' }],
    }),
  ));
  for (const r of results) assert.ok(!r.isError, `add_contacts failed: ${JSON.stringify(r.payload)}`);

  const { getDb } = await import('../dist/db.js');
  const rows = getDb().prepare(
    `SELECT full_name FROM linkedin_connections WHERE full_name LIKE 'Concurrent Contact %' ORDER BY full_name`,
  ).all();
  assert.equal(rows.length, 10, `expected all 10 concurrent contacts persisted, got ${rows.length}`);
});

// ── C. Concurrent requests do not cross wires ────────────────────────────────

test('overlapping requests from different clients each get their own response', async () => {
  const clients = Array.from({ length: 6 }, (_, i) => mcpClient(`parallel-${i}`));
  await Promise.all(clients.map((c) => c.initialize()));

  // Mixed read tools fired simultaneously with DISTINCT request ids; each JSON
  // response must carry its own id (a shared protocol instance would misroute).
  const calls = clients.map((c, i) =>
    i % 2 === 0
      ? c.callTool('get_tracker', {}, { id: 1000 + i })
      : c.callTool('doctor', {}, { id: 1000 + i }),
  );
  const settled = await Promise.all(calls);
  for (const [i, r] of settled.entries()) {
    assert.equal(r.body.id, 1000 + i, `response ${i} routed to the wrong request`);
    assert.ok(r.body.result, `response ${i} has no result`);
  }
});

// ── D. /api/status — verify the shared instance + source-of-truth DB ────────

test('/api/status reports the shared DB and the clients seen', async () => {
  const r = await fetch(`${baseUrl}/api/status`);
  assert.equal(r.status, 200);
  const s = await r.json();

  assert.equal(s.db_path, resolve(sandbox, 'data', 'mcp-jsa.db'), 'status must name the one source-of-truth DB');
  assert.match(s.db_fingerprint, /^[0-9a-f]{12}$/);
  assert.ok(s.uptime_s >= 0);
  assert.ok(s.mcp_requests_total >= 18, `expected the test traffic counted (got ${s.mcp_requests_total})`);

  const names = s.clients_seen.map((c) => c.name);
  assert.ok(names.includes('client-a-claude-code'), `clients_seen missing client A: ${names}`);
  assert.ok(names.includes('client-b-opencode'),    `clients_seen missing client B: ${names}`);
  assert.ok(names.some((n) => n.startsWith('writer-')), 'concurrent writers should be tracked too');
});

test('healthz stays open and PII-free (no DB path)', async () => {
  const r = await fetch(`${baseUrl}/healthz`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.db_path, undefined, '/healthz must not leak the DB path — that detail is auth-gated on /api/status');
});
