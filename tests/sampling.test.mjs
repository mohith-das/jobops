// Feature 1: MCP sampling scoring path.
//   Part A — pickCompleter selection logic (sampling vs api vs none).
//   Part B — batch_evaluate scores a job via a MOCK sampling client (no BYO key), records
//            an llm_calls row tagged provider='sampling'.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A mock ClientBridge that advertises sampling and returns a canned strict-JSON score.
function mockSamplingBridge(jsonText) {
  return {
    canSample:    () => true,
    canElicit:    () => false,
    canElicitUrl: () => false,
    sample: async () => ({ text: jsonText, model: 'mock-client-model' }),
    elicitForm: async () => { throw new Error('not used'); },
    elicitUrl:  async () => { throw new Error('not used'); },
  };
}

const SCORE_JSON = JSON.stringify({
  resume_fit: 82, taste_fit: 71, visa_fit: 64, score_total: 76,
  role_category: 'swe', seniority: 'mid', reasoning: 'strong overlap', concerns: 'none',
});

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-sampling-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = sandbox + '/output';
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  process.env.JOBOPS_SAMPLING     = 'true';
  delete process.env.GEMINI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.JOBOPS_LLM_PROVIDER = 'none';
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

// ── Part A: pickCompleter ──────────────────────────────────────────────────────

test('pickCompleter prefers sampling when the client advertises it (no key needed)', async () => {
  const { pickCompleter } = await import('../dist/core/scoring.js');
  const picked = pickCompleter(mockSamplingBridge(SCORE_JSON));
  assert.ok(picked);
  assert.equal(picked.kind, 'sampling');
});

test('pickCompleter returns null when neither sampling nor a BYO key is available', async () => {
  const { pickCompleter } = await import('../dist/core/scoring.js');
  const noCaps = { canSample: () => false, canElicit: () => false, canElicitUrl: () => false,
                   sample: async () => ({ text: '', model: '' }), elicitForm: async () => ({ action: 'cancel' }), elicitUrl: async () => ({ action: 'cancel' }) };
  assert.equal(pickCompleter(noCaps), null);
  assert.equal(pickCompleter(undefined), null);
});

// ── Part B: batch_evaluate via sampling ─────────────────────────────────────────

test('batch_evaluate scores an unrated job via the sampling client', async () => {
  const { upsertJob } = await import('../dist/core/jobs.js');
  const { batchEvaluateTool } = await import('../dist/mcp/tools/batch_evaluate.js');
  const { getDb } = await import('../dist/db.js');

  const job = await upsertJob({
    source: 'test', source_url: 'test://sampling/' + Math.random(),
    company_name: 'SamplingCo', title: 'Backend Engineer',
    description: 'Build distributed systems in Go. 5y experience. Kubernetes, Postgres.',
  });

  const res = await batchEvaluateTool.handler(
    { limit: 10, concurrency: 1 },
    { bridge: mockSamplingBridge(SCORE_JSON) },
  );
  const payload = res.structuredContent;
  assert.equal(payload.scored_via, 'sampling', 'should have scored via sampling');
  assert.ok(payload.rated >= 1, `expected >=1 rated, got ${payload.rated}`);
  assert.equal(payload.parse_errors, 0);

  // The job row now carries the score.
  const row = getDb().prepare('SELECT score_total, score_resume_fit, role_category FROM jobs WHERE id = ?').get(job.id);
  assert.equal(row.score_total, 76);
  assert.equal(row.score_resume_fit, 82);
  assert.equal(row.role_category, 'swe');

  // Telemetry recorded the sampling call (so cost_estimate can flag it as client-borne).
  const calls = getDb().prepare("SELECT provider, model FROM llm_calls WHERE provider = 'sampling'").all();
  assert.ok(calls.length >= 1, 'expected a sampling llm_calls row');
  assert.equal(calls[0].model, 'mock-client-model');
});

// ── Part C: transport-aware gating (RealClientBridge) ───────────────────────────

test('RealClientBridge gates sampling/elicitation on the transport, not just capabilities', async () => {
  const { RealClientBridge, setDuplexCapable, isDuplexCapable } = await import('../dist/mcp/client_bridge.js');
  // A fake McpServer that advertises every capability.
  const fakeServer = {
    server: { getClientCapabilities: () => ({ sampling: {}, elicitation: { form: {}, url: {} } }) },
  };
  const bridge = new RealClientBridge(fakeServer);

  setDuplexCapable(false);
  assert.equal(isDuplexCapable(), false);
  assert.equal(bridge.canSample(), false, 'no server→client requests over a non-duplex transport (HTTP) → gate off');
  assert.equal(bridge.canElicit(), false);
  assert.equal(bridge.canElicitUrl(), false);

  setDuplexCapable(true);   // stdio
  assert.equal(bridge.canSample(), true);
  assert.equal(bridge.canElicit(), true);
  assert.equal(bridge.canElicitUrl(), true);
  setDuplexCapable(false);  // reset
});

test('RealClientBridge.canElicit requires the form sub-capability (URL-only client → false)', async () => {
  const { RealClientBridge, setDuplexCapable } = await import('../dist/mcp/client_bridge.js');
  setDuplexCapable(true);
  const urlOnly = new RealClientBridge({ server: { getClientCapabilities: () => ({ elicitation: { url: {} } }) } });
  assert.equal(urlOnly.canElicit(), false, 'URL-only client must not pass the form gate');
  assert.equal(urlOnly.canElicitUrl(), true);
  setDuplexCapable(false);
});

test('batch_evaluate errors clearly when no scoring backend is available', async () => {
  const { batchEvaluateTool } = await import('../dist/mcp/tools/batch_evaluate.js');
  const noBridge = { canSample: () => false, canElicit: () => false, canElicitUrl: () => false,
                     sample: async () => ({ text: '', model: '' }), elicitForm: async () => ({ action: 'cancel' }), elicitUrl: async () => ({ action: 'cancel' }) };
  const res = await batchEvaluateTool.handler({ limit: 10, concurrency: 1 }, { bridge: noBridge });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /sampling|GEMINI_API_KEY|chat/);
});
