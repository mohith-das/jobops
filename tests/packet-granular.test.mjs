// Granular career-packet edits: edit/remove ONE item, version history, restore, visa scan.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CV_MD = `# CV — Test User
**Location:** Test City

## Work Experience

### Acme Corp — Senior Engineer
Remote · 2020 – 2024
- Built the core ingestion pipeline processing millions of records per day reliably
- Shipped a customer-facing analytics surface adopted across many teams

## Projects & Open Source

- **CoolProject** (Open Source) — a distinctive tool that exercises the parser end to end
- **SecondProject** — another well-described project that should remain untouched by edits

## Skills

- **Languages:** Python, TypeScript, SQL

## Education

- **MS Computer Science**, Test University — 2019
`;
const PROFILE_YML = `candidate:
  full_name: "Test User"
  email: "test@example.com"
taglines:
  "Builder": "builds data + AI products end to end"
`;

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-packet-granular-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = sandbox + '/output';
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  writeFileSync(join(sandbox, 'cv.md'), CV_MD, 'utf-8');
  writeFileSync(join(sandbox, 'config', 'profile.yml'), PROFILE_YML, 'utf-8');
  const { getDb } = await import('../dist/db.js');
  getDb();
});
after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

async function resetToReseed() {
  const { seedCareerPacketFromFiles } = await import('../dist/core/profile.js');
  await seedCareerPacketFromFiles({ mode: 'reseed', force: true });
}

test('edit_packet_item changes only the targeted item, in place, and versions', async () => {
  const { editPacketItem, getActiveCareerPacket } = await import('../dist/core/profile.js');
  await resetToReseed();
  const v0 = getActiveCareerPacket().version;

  const r = await editPacketItem('projects', 'CoolProject', 'CoolProject v2 — now with a measurable result');
  assert.equal(r.new_version, v0 + 1);
  assert.match(r.old_item, /CoolProject/);
  const content = getActiveCareerPacket().content;
  assert.match(content, /CoolProject v2 — now with a measurable result/);
  assert.match(content, /SecondProject/, 'the other project is untouched');
});

test('remove_packet_item removes ONLY that item; a prior version is restorable', async () => {
  const { removePacketItem, restorePacketVersion, listPacketVersions, getActiveCareerPacket } =
    await import('../dist/core/profile.js');
  await resetToReseed();
  const vBefore = getActiveCareerPacket().version;
  assert.match(getActiveCareerPacket().content, /SecondProject/);

  const rm = await removePacketItem('projects', 'SecondProject');
  assert.match(rm.removed_item, /SecondProject/);
  const afterRemove = getActiveCareerPacket().content;
  assert.doesNotMatch(afterRemove, /SecondProject/, 'removed item gone');
  assert.match(afterRemove, /CoolProject/, 'other items intact');

  // The removed item survives in history → restore the pre-removal version.
  assert.ok(listPacketVersions().some(v => v.version === vBefore));
  const res = await restorePacketVersion(vBefore);
  assert.ok(res.new_version > rm.new_version);
  assert.match(getActiveCareerPacket().content, /SecondProject/, 'restored content brings the item back');
});

test('edit_packet_item tool refuses visa/work-auth language (hard rule) and does not change the packet', async () => {
  const { editPacketItemTool } = await import('../dist/mcp/tools/packet_edit.js');
  const { getActiveCareerPacket } = await import('../dist/core/profile.js');
  await resetToReseed();
  const v = getActiveCareerPacket().version;
  const res = await editPacketItemTool.handler({ section: 'projects', item: 1, new_text: 'I would require visa sponsorship for this role' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /visa/i);
  assert.equal(getActiveCareerPacket().version, v, 'packet unchanged after a refused edit');
});

test('granular edit addresses items by 1-based index and errors out of range', async () => {
  const { editPacketItem, removePacketItem } = await import('../dist/core/profile.js');
  await resetToReseed();
  // index 2 in projects = SecondProject
  const r = await editPacketItem('6', 2, 'SecondProject — refined description');
  assert.match(r.old_item, /SecondProject/);
  await assert.rejects(() => removePacketItem('projects', 99), /out of range/i);
});

test('restore_packet_version tool lists versions when called without a version', async () => {
  const { restorePacketVersionTool } = await import('../dist/mcp/tools/packet_edit.js');
  await resetToReseed();
  const res = await restorePacketVersionTool.handler({});
  assert.ok(Array.isArray(res.structuredContent.versions));
  assert.ok(res.structuredContent.versions.length >= 1);
});
