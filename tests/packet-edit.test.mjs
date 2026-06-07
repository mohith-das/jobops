// Chat-driven packet editing: update_career_packet is the primary edit surface, and reseed
// must NOT silently destroy those edits.
//   A. chat edit marks the packet user-edited (origin=chat_edit); packetStatus reflects it.
//   B. reseed WITHOUT force is refused (blocked) — edits preserved + warning.
//   C. reseed WITH force rebuilds from cv.md as before.
//   D. update_career_packet section edit changes only that section + versions.
//   E. sync_packet_to_cv writes the packet back into cv.md; a forced reseed reproduces it.
//   F. visa-leakage hard rule still intact.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CV_MD = `# CV — Test User
**Location:** Test City, USA
**Email:** test@example.com

## Professional Summary
A product-minded builder who ships data and AI systems end to end with measurable impact.

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
- Maintained a fleet of internal tools used daily across several operations teams

## Projects & Open Source

- **CoolProject** (Open Source) — a distinctive open-source tool for testing the round-trip path
- **SecondProject** — another well-described project that exercises the parser end to end

## Skills

- **Languages:** Python, TypeScript, SQL, Bash
- **AI / LLM Systems:** RAG, agents, vector DBs, MCP

## Education

- **MS Computer Science** — Test University (2019). Coursework in ML and systems
`;

const PROFILE_YML = `candidate:
  full_name: "Test User"
  email: "test@example.com"
  location: "Test City, USA"
taglines:
  "Builder": "builds data + AI products end to end"
  "Engineer": "ships reliable distributed systems"
`;

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-packet-edit-'));
  process.env.MCP_JSA_DATA_DIR     = sandbox;
  process.env.MCP_JSA_OUTPUT_DIR   = sandbox + '/output';
  process.env.MCP_JSA_PROJECT_ROOT = sandbox;
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  writeFileSync(join(sandbox, 'cv.md'), CV_MD, 'utf-8');
  writeFileSync(join(sandbox, 'config', 'profile.yml'), PROFILE_YML, 'utf-8');
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

// Force-reseed to a known reseed-origin baseline.
async function resetToReseed() {
  const { seedCareerPacketFromFiles } = await import('../dist/core/profile.js');
  const r = await seedCareerPacketFromFiles({ mode: 'reseed', force: true });
  assert.equal(r.blocked, false);
  return r;
}

// ── A. chat edit marks the packet user-edited ──────────────────────────────────

test('reseed produces a reseed-origin packet that packetStatus calls "ok"', async () => {
  const { getActiveCareerPacket, packetStatus, loadProjectFiles } = await import('../dist/core/profile.js');
  await resetToReseed();
  const active = getActiveCareerPacket();
  assert.equal(active.origin, 'reseed');
  assert.match(active.content, /CoolProject/);     // sourced from cv.md
  assert.match(active.content, /builds data \+ AI products/);  // tagline from profile.yml
  assert.equal(packetStatus({ active, cvMd: loadProjectFiles().cvMd }), 'ok');
});

test('update_career_packet (full) marks origin=chat_edit; packetStatus → packet_chat_edited', async () => {
  const { updateCareerPacketTool } = await import('../dist/mcp/tools/ops.js');
  const { getActiveCareerPacket, packetStatus, loadProjectFiles } = await import('../dist/core/profile.js');
  await resetToReseed();
  const before = getActiveCareerPacket();

  const edited = before.content + '\n\n<!-- CHAT-EDIT-MARKER-1 -->\n';
  const res = await updateCareerPacketTool.handler({ content: edited });
  assert.equal(res.structuredContent.origin, 'chat_edit');
  assert.equal(res.structuredContent.version, before.version + 1);

  const active = getActiveCareerPacket();
  assert.equal(active.origin, 'chat_edit');
  assert.match(active.content, /CHAT-EDIT-MARKER-1/);
  // doctor's signal: chat-edited, NOT a staleness nag.
  assert.equal(packetStatus({ active, cvMd: loadProjectFiles().cvMd }), 'packet_chat_edited');
});

// ── B. reseed without force is refused ─────────────────────────────────────────

test('reseed WITHOUT force is blocked when the packet is chat-edited (edits preserved)', async () => {
  const { reseedCareerPacketTool } = await import('../dist/mcp/tools/reseed.js');
  const { updateCareerPacketTool } = await import('../dist/mcp/tools/ops.js');
  const { getActiveCareerPacket } = await import('../dist/core/profile.js');
  await resetToReseed();
  await updateCareerPacketTool.handler({ content: (getActiveCareerPacket().content + '\n<!-- KEEP-ME -->\n') });
  const chatVersion = getActiveCareerPacket().version;

  const res = await reseedCareerPacketTool.handler({});
  assert.equal(res.isError, true, 'reseed must be refused');
  assert.match(res.content[0].text, /chat edits|overwrite|refused/i);

  // Nothing changed — the chat-edited packet is still active and intact.
  const after = getActiveCareerPacket();
  assert.equal(after.version, chatVersion, 'no new version written');
  assert.equal(after.origin, 'chat_edit');
  assert.match(after.content, /KEEP-ME/);
});

// ── C. reseed with force rebuilds from cv.md ───────────────────────────────────

test('reseed WITH force rebuilds from cv.md (chat edits dropped, origin back to reseed)', async () => {
  const { reseedCareerPacketTool } = await import('../dist/mcp/tools/reseed.js');
  const { updateCareerPacketTool } = await import('../dist/mcp/tools/ops.js');
  const { getActiveCareerPacket } = await import('../dist/core/profile.js');
  await resetToReseed();
  await updateCareerPacketTool.handler({ content: (getActiveCareerPacket().content + '\n<!-- DROP-ON-FORCE -->\n') });

  const res = await reseedCareerPacketTool.handler({ force: true });
  assert.equal(res.structuredContent.ok, true);
  assert.equal(res.structuredContent.forced, true);

  const active = getActiveCareerPacket();
  assert.equal(active.origin, 'reseed');
  assert.doesNotMatch(active.content, /DROP-ON-FORCE/, 'chat marker gone after forced rebuild');
  assert.match(active.content, /CoolProject/, 'cv.md content present again');
});

// ── D. section edit ────────────────────────────────────────────────────────────

test('update_career_packet section edit changes only that section + versions', async () => {
  const { updateCareerPacketTool } = await import('../dist/mcp/tools/ops.js');
  const { getActiveCareerPacket } = await import('../dist/core/profile.js');
  await resetToReseed();
  const before = getActiveCareerPacket();

  const res = await updateCareerPacketTool.handler({
    section: '2',
    section_content: '- **Builder** — "DISTINCTIVE NEW TAGLINE"',
  });
  assert.equal(res.structuredContent.origin, 'chat_edit');
  assert.equal(res.structuredContent.version, before.version + 1);

  const active = getActiveCareerPacket();
  assert.match(active.content, /DISTINCTIVE NEW TAGLINE/);        // section 2 changed
  assert.match(active.content, /CoolProject/);                    // section 6 untouched
  assert.doesNotMatch(active.content, /ships reliable distributed systems/); // old tagline replaced
});

test('section edit on a missing section errors clearly', async () => {
  const { updateCareerPacketTool } = await import('../dist/mcp/tools/ops.js');
  await resetToReseed();
  const res = await updateCareerPacketTool.handler({ section: '99', section_content: '- nope' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /not found/i);
});

// ── E. sync-back round trip ────────────────────────────────────────────────────

test('sync_packet_to_cv writes the packet into cv.md; a forced reseed reproduces it', async () => {
  const { syncPacketToCvTool } = await import('../dist/mcp/tools/sync_packet.js');
  const { reseedCareerPacketTool } = await import('../dist/mcp/tools/reseed.js');
  const { updateCareerPacketTool } = await import('../dist/mcp/tools/ops.js');
  const { getActiveCareerPacket, editPacketSection } = await import('../dist/core/profile.js');
  await resetToReseed();

  // Chat-only edit: add a distinctive project to Section 6 that does NOT exist in cv.md.
  const base = getActiveCareerPacket().content;
  const sec6 = '- **CoolProject** (Open Source) — a distinctive open-source tool for testing the round-trip path\n'
             + '- **SecondProject** — another well-described project that exercises the parser end to end\n'
             + '- **ChatOnlyProject** — this project was added via chat and lives only in the packet';
  const editedFull = editPacketSection(base, '6', sec6);
  await updateCareerPacketTool.handler({ content: editedFull });
  assert.doesNotMatch(readFileSync(join(sandbox, 'cv.md'), 'utf-8'), /ChatOnlyProject/, 'precondition: not yet in cv.md');

  // Sync back → cv.md now carries the chat-only project.
  const sync = await syncPacketToCvTool.handler({});
  assert.equal(sync.structuredContent.ok, true);
  const cvAfter = readFileSync(join(sandbox, 'cv.md'), 'utf-8');
  assert.match(cvAfter, /ChatOnlyProject/, 'cv.md updated from the packet');

  // A forced reseed (cv.md → packet) now reproduces the chat-only project.
  const res = await reseedCareerPacketTool.handler({ force: true });
  assert.equal(res.structuredContent.ok, true);
  assert.match(getActiveCareerPacket().content, /ChatOnlyProject/, 'reseed reproduced the synced edit');
  // Education institution survives the packet → cv.md → reseed round-trip (org not lost).
  assert.match(getActiveCareerPacket().content, /Test University/, 'education org survived the round-trip');
});

test('sync_packet_to_cv then_reseed:true leaves a consistent reseed-origin packet', async () => {
  const { syncPacketToCvTool } = await import('../dist/mcp/tools/sync_packet.js');
  const { updateCareerPacketTool } = await import('../dist/mcp/tools/ops.js');
  const { getActiveCareerPacket } = await import('../dist/core/profile.js');
  await resetToReseed();
  // Change a tagline via chat, then sync + reseed in one shot.
  await updateCareerPacketTool.handler({ section: '2', section_content: '- **Builder** — "SYNCED TAGLINE XYZ"' });
  const res = await syncPacketToCvTool.handler({ then_reseed: true });
  assert.equal(res.structuredContent.reseeded, true);
  const active = getActiveCareerPacket();
  assert.equal(active.origin, 'reseed');
  assert.match(active.content, /SYNCED TAGLINE XYZ/, 'tagline survived packet → profile.yml → reseed');
});

// ── F. hard rule intact ────────────────────────────────────────────────────────

test('visa-leakage scan (hard rule) is still enforced on candidate-facing output', async () => {
  const { scanForVisaLeakage } = await import('../dist/core/outreach_safety.js');
  const leaks = scanForVisaLeakage('I would require visa sponsorship for this role.');
  assert.ok(leaks.length > 0, 'visa mention in candidate-facing text must still be caught');
});
