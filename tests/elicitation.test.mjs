// Feature 2: MCP elicitation.
//   Part A — contentToProfileUpdate pure mapping.
//   Part B — update_profile drives a MOCK form elicitation, writes profile.yml, reseeds.
//   Part C — fallback when the client supports no elicitation (no fields) is graceful.
//   Part D — URL-mode capture registry: createCapture + submit resolves the promise.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A mock ClientBridge for form-mode elicitation.
function mockFormBridge(content, action = 'accept') {
  return {
    canSample:    () => false,
    canElicit:    () => true,
    canElicitUrl: () => false,
    sample: async () => ({ text: '', model: '' }),
    elicitForm: async () => ({ action, content }),
    elicitUrl:  async () => { throw new Error('not used'); },
  };
}
const noElicitBridge = {
  canSample: () => false, canElicit: () => false, canElicitUrl: () => false,
  sample: async () => ({ text: '', model: '' }),
  elicitForm: async () => { throw new Error('not used'); },
  elicitUrl: async () => { throw new Error('not used'); },
};

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-elicit-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = sandbox + '/output';
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

// ── Part A ──────────────────────────────────────────────────────────────────--

test('contentToProfileUpdate maps flat form fields → structured update', async () => {
  const { contentToProfileUpdate } = await import('../dist/mcp/tools/profile_elicit.js');
  const u = contentToProfileUpdate({
    full_name: 'Ada Lovelace', email: 'ada@example.com', phone: '',
    tagline_1_archetype: 'Builder PM', tagline_1_text: 'ships product with engineering teeth',
    tagline_2_archetype: 'Applied AI Engineer', tagline_2_text: '',  // incomplete pair dropped
  });
  assert.equal(u.candidate.full_name, 'Ada Lovelace');
  assert.equal(u.candidate.email, 'ada@example.com');
  assert.ok(!('phone' in u.candidate), 'empty field should be dropped');
  assert.deepEqual(u.taglines, { 'Builder PM': 'ships product with engineering teeth' });
});

// ── Part B ──────────────────────────────────────────────────────────────────--

test('update_profile: form elicitation writes profile.yml and reseeds', async () => {
  const { updateProfileTool } = await import('../dist/mcp/tools/profile_elicit.js');
  const yaml = await import('js-yaml');

  const bridge = mockFormBridge({
    full_name: 'Grace Hopper',
    email: 'grace@example.com',
    location: 'Arlington, USA',
    tagline_1_archetype: 'Builder PM',
    tagline_1_text: 'ships product with engineering teeth',
    tagline_2_archetype: 'Forward-Deployed',
    tagline_2_text: 'embeds with customers and closes the deal',
  });

  const res = await updateProfileTool.handler({ reseed: true }, { bridge });
  const payload = res.structuredContent;
  assert.equal(payload.updated, true);
  assert.ok(payload.candidate_fields_set >= 3);
  assert.equal(payload.taglines_set, 2);
  assert.ok(payload.reseed && payload.reseed.new_version >= 1);

  // profile.yml on disk reflects the elicited values.
  const profile = yaml.default.load(readFileSync(join(sandbox, 'config', 'profile.yml'), 'utf-8'));
  assert.equal(profile.candidate.full_name, 'Grace Hopper');
  assert.equal(profile.candidate.email, 'grace@example.com');
  assert.equal(profile.taglines['Builder PM'], 'ships product with engineering teeth');
  assert.equal(profile.taglines['Forward-Deployed'], 'embeds with customers and closes the deal');

  // The reseeded career packet picked up the taglines in Section 2.
  const { getActiveCareerPacket } = await import('../dist/core/profile.js');
  assert.match(getActiveCareerPacket().content, /\*\*Builder PM\*\* — "ships product with engineering teeth"/);
});

test('update_profile: declining the form leaves the profile unchanged', async () => {
  const { updateProfileTool } = await import('../dist/mcp/tools/profile_elicit.js');
  const res = await updateProfileTool.handler({ reseed: false }, { bridge: mockFormBridge(undefined, 'decline') });
  assert.equal(res.structuredContent.updated, false);
  assert.equal(res.structuredContent.action, 'decline');
});

// ── Part C ──────────────────────────────────────────────────────────────────--

test('update_profile: no elicitation support + no fields → graceful fallback', async () => {
  const { updateProfileTool } = await import('../dist/mcp/tools/profile_elicit.js');
  const res = await updateProfileTool.handler({ reseed: false }, { bridge: noElicitBridge });
  assert.equal(res.structuredContent.updated, false);
  assert.equal(res.structuredContent.elicitation_supported, false);
  assert.ok(Array.isArray(res.structuredContent.editable_fields));
});

test('update_profile: programmatic `fields` path works without any elicitation', async () => {
  const { updateProfileTool } = await import('../dist/mcp/tools/profile_elicit.js');
  const res = await updateProfileTool.handler(
    { fields: { full_name: 'Katherine Johnson', email: 'kj@example.com' }, reseed: false },
    { bridge: noElicitBridge },
  );
  assert.equal(res.structuredContent.updated, true);
  assert.ok(res.structuredContent.candidate_fields_set >= 2);
});

// ── Part D: URL-mode capture registry ─────────────────────────────────────────

test('createCapture + submitCapture resolves the out-of-band promise', async () => {
  const { createCapture, submitCapture, hasCapture } = await import('../dist/http/elicit.js');
  const cap = createCapture({ label: 'LinkedIn path', field: 'path', ttlMs: 5000 });
  assert.ok(cap.url.includes('/elicit/'));
  assert.equal(hasCapture(cap.id), true);
  const submitted = submitCapture(cap.id, '/Users/me/Connections.csv');
  assert.equal(submitted, true);
  assert.equal(await cap.promise, '/Users/me/Connections.csv');
  assert.equal(hasCapture(cap.id), false, 'capture consumed after submit');
});
