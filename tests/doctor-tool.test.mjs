// The `doctor` MCP tool + shared runDoctorChecks: read-only health report, reused by the
// CLI and the tool, tuned for the running-server context.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CV_MD = `# CV — Test User
**Location:** Test City, USA

## Work Experience

### Acme Corp — Senior Engineer
Remote · 2020 – 2024
- Built the core ingestion pipeline that processed millions of records per day reliably
- Shipped a customer-facing analytics surface adopted across more than fifty teams
- Led a reliability initiative that cut incident turnaround time by roughly sixty percent

### Globex — Software Engineer
India · 2017 – 2020
- Designed a microservices migration that reduced infrastructure cost by a third
- Implemented an A/B testing framework used for every feature decision in the app

### Initech — Junior Developer
India · 2015 – 2017
- Automated payroll and invoicing workflows that saved the finance team hours each week
- Maintained internal tools used daily across several operations teams

## Projects & Open Source

- **CoolProject** (Open Source) — a distinctive open-source tool for testing the pipeline
- **SecondProject** — another well-described project exercising the parser end to end

## Skills

- **Languages:** Python, TypeScript, SQL, Bash

## Education

- **MS Computer Science**, Test University — 2019. Coursework in ML and systems
`;

const PROFILE_YML = `candidate:
  full_name: "Test User"
  email: "test@example.com"
  location: "Test City, USA"
taglines:
  "Builder": "builds data + AI products end to end"
`;

const PORTALS_YML = `# tracked portals (test fixture — must exceed the 200-byte "looks real" threshold)
tracked_companies:
  - name: "Acme"
    careers_url: "https://job-boards.greenhouse.io/acme"
    priority: 1
    enabled: true
  - name: "Globex"
    careers_url: "https://jobs.ashbyhq.com/globex"
    priority: 2
    enabled: true
`;

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-doctor-'));
  process.env.MCP_JSA_DATA_DIR     = sandbox;
  process.env.MCP_JSA_OUTPUT_DIR   = sandbox + '/output';
  process.env.MCP_JSA_PROJECT_ROOT = sandbox;
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  writeFileSync(join(sandbox, 'cv.md'), CV_MD, 'utf-8');
  writeFileSync(join(sandbox, 'config', 'profile.yml'), PROFILE_YML, 'utf-8');
  writeFileSync(join(sandbox, 'portals.yml'), PORTALS_YML, 'utf-8');
  const { getDb } = await import('../dist/db.js');
  getDb();
});
after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

const byId = (report, id) => report.checks.find(c => c.id === id);

test('runDoctorChecks(server) returns a structured report with the expected checks', async () => {
  const { runDoctorChecks } = await import('../dist/core/doctor.js');
  const { seedCareerPacketFromFiles } = await import('../dist/core/profile.js');
  await seedCareerPacketFromFiles({ mode: 'reseed', force: true });

  const r = await runDoctorChecks({ context: 'server' });
  assert.equal(r.context, 'server');
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(r.package.version, 'reports package version');
  assert.ok(Array.isArray(r.checks) && r.checks.length >= 12);
  assert.equal(r.counts.pass + r.counts.warn + r.counts.fail + r.counts.info, r.checks.length);

  // The documented checks are all present.
  for (const id of ['node', 'chromium', 'llm', 'sampling', 'visa', 'templates', 'modes',
                     'auth', 'public_base_url', 'listen', 'career_packet']) {
    assert.ok(byId(r, id), `missing check: ${id}`);
  }
  // Healthy packet ↔ cv.md sync.
  assert.equal(byId(r, 'career_packet').status, 'pass');
  assert.match(byId(r, 'career_packet').detail, /matches current cv\.md/);
  // Server context relabels the bind as informational ("listening"), not a port check.
  assert.equal(byId(r, 'listen').status, 'info');
  assert.match(byId(r, 'listen').detail, /server bound/);
});

test('doctor tool returns the report as structuredContent and is read-only', async () => {
  const { doctorTool } = await import('../dist/mcp/tools/doctor.js');
  const { getActiveCareerPacket } = await import('../dist/core/profile.js');
  const vBefore = getActiveCareerPacket().version;

  const res = await doctorTool.handler({});
  assert.ok(res.structuredContent, 'returns structuredContent');
  assert.equal(res.structuredContent.context, 'server');
  assert.ok(Array.isArray(res.structuredContent.checks));
  assert.ok(res.structuredContent.summary.length > 0);

  // Read-only: calling it did not bump the packet version or mutate state.
  assert.equal(getActiveCareerPacket().version, vBefore, 'doctor must not mutate the packet');
  const res2 = await doctorTool.handler({});
  assert.equal(getActiveCareerPacket().version, vBefore);
  assert.equal(res2.structuredContent.checks.length, res.structuredContent.checks.length);
});

test('reports chat-edited packet state (not a staleness nag)', async () => {
  const { runDoctorChecks } = await import('../dist/core/doctor.js');
  const { seedCareerPacketFromFiles, writeChatEditedPacket, getActiveCareerPacket } = await import('../dist/core/profile.js');
  await seedCareerPacketFromFiles({ mode: 'reseed', force: true });
  await writeChatEditedPacket(getActiveCareerPacket().content + '\n<!-- chat -->\n');

  const cp = byId(await runDoctorChecks({ context: 'server' }), 'career_packet');
  assert.equal(cp.status, 'pass');
  assert.match(cp.detail, /chat-edited/);
});

test('sampling check reports the LIVE negotiated client state (no overstatement)', async () => {
  const { runDoctorChecks } = await import('../dist/core/doctor.js');
  const { seedCareerPacketFromFiles } = await import('../dist/core/profile.js');
  await seedCareerPacketFromFiles({ mode: 'reseed', force: true });

  // Client connected but did NOT advertise sampling (e.g. Claude Desktop) → BYO key.
  const notAdv = byId(await runDoctorChecks({
    context: 'server', sampling: { clientConnected: true, advertised: false, usable: false },
  }), 'sampling');
  assert.match(notAdv.detail, /NOT advertised/i);
  assert.match(notAdv.detail, /BYO key/i);
  assert.match(notAdv.detail, /modelcontextprotocol\.io\/clients/);

  // Client advertised sampling and it's usable → key optional.
  const adv = byId(await runDoctorChecks({
    context: 'server', sampling: { clientConnected: true, advertised: true, usable: true },
  }), 'sampling');
  assert.match(adv.detail, /available/i);
  assert.match(adv.detail, /optional/i);

  // No live info (e.g. cold CLI) → general "depends on your client" guidance, no claim that
  // stdio/Claude Desktop grants sampling.
  const cold = byId(await runDoctorChecks({ context: 'cold' }), 'sampling');
  assert.match(cold.detail, /only if the connected client advertises|engages automatically IF the connected client advertises/i);
  assert.match(cold.detail, /Claude Desktop/);
  assert.doesNotMatch(cold.detail, /stdio client.*(no key|key optional)/i);
});

test('doctor tool threads the live sampling state from the connected client', async () => {
  const { doctorTool } = await import('../dist/mcp/tools/doctor.js');
  const { seedCareerPacketFromFiles } = await import('../dist/core/profile.js');
  await seedCareerPacketFromFiles({ mode: 'reseed', force: true });

  // Mock a connected client that did NOT advertise sampling (the Claude Desktop case).
  const bridge = {
    canSample: () => false, canElicit: () => false, canElicitUrl: () => false,
    clientConnected: () => true, clientAdvertisedSampling: () => false,
    sample: async () => ({ text: '', model: '' }),
    elicitForm: async () => ({ action: 'cancel' }), elicitUrl: async () => ({ action: 'cancel' }),
  };
  const res = await doctorTool.handler({}, { bridge });
  const sampling = res.structuredContent.checks.find(c => c.id === 'sampling');
  assert.match(sampling.detail, /NOT advertised/i);
});

test('cv.md-edited-after-reseed: warning in server context, failure in cold context', async () => {
  const { runDoctorChecks } = await import('../dist/core/doctor.js');
  const { seedCareerPacketFromFiles } = await import('../dist/core/profile.js');
  await seedCareerPacketFromFiles({ mode: 'reseed', force: true });
  // Edit cv.md on disk so its hash no longer matches the reseed-origin packet.
  writeFileSync(join(sandbox, 'cv.md'), CV_MD + '\n- An extra bullet edited directly into cv.md after the reseed\n', 'utf-8');

  const server = byId(await runDoctorChecks({ context: 'server' }), 'career_packet');
  const cold   = byId(await runDoctorChecks({ context: 'cold' }),   'career_packet');
  assert.equal(server.status, 'warn', 'running server: stale-but-working → warning');
  assert.equal(cold.status, 'fail', 'cold start: hard failure (preserves CLI behavior)');
  assert.match(server.detail, /edited after the last reseed/);
});
