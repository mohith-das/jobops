// Regression for bug 1: visa-rail scan must NOT trip on internal tailoring_notes that
// (legitimately) mention visa as a deliberate-omission note. It must STILL trip when
// the candidate-facing cover_letter_body or bullets mention visa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { candidateFacingMaterialsText } from '../dist/mcp/tools/generate_materials.js';
import { scanForVisaLeakage } from '../dist/core/outreach_safety.js';

test('candidateFacingMaterialsText: includes the deliverable fields, omits internal meta', () => {
  const m = {
    tagline:           'Builder PM with engineering teeth',
    experience_bullets: { recent: ['Led an end-to-end product launch', 'Built AI agents'] },
    projects_section:  '\\resumeProjectHeading{sample}',
    skills_section:    '\\item Python, SQL',
    cover_letter_body: 'I am reaching out about the role.',
    tailoring_notes:   'Deliberately omitted visa references per the safety rail.',
  };
  const blob = candidateFacingMaterialsText(m);
  assert.match(blob, /Builder PM with engineering teeth/);
  assert.match(blob, /Led an end-to-end product launch/);
  assert.match(blob, /reaching out about the role/);
  assert.match(blob, /Python, SQL/);
  assert.doesNotMatch(blob, /visa/i,             'tailoring_notes must not leak into the scan');
  assert.doesNotMatch(blob, /safety rail/i,      'tailoring_notes must not leak into the scan');
});

test('scan PASSES when visa only appears in tailoring_notes', () => {
  const m = {
    cover_letter_body: 'Excited about the role and the team you are building.',
    tailoring_notes:   'Made sure not to mention visa or sponsorship anywhere in the deliverable.',
  };
  const leaks = scanForVisaLeakage(candidateFacingMaterialsText(m));
  assert.equal(leaks.length, 0, `expected zero leaks, got: ${JSON.stringify(leaks)}`);
});

test('scan FAILS when visa appears in cover_letter_body', () => {
  const m = {
    cover_letter_body: 'I would require visa sponsorship for this role.',
    tailoring_notes:   'fine',
  };
  const leaks = scanForVisaLeakage(candidateFacingMaterialsText(m));
  assert.ok(leaks.length > 0, 'cover_letter_body visa mention must be caught');
  assert.ok(leaks.some(l => /visa/i.test(l.hit) || l.rule === 'no_visa_mentions'));
});

test('scan FAILS when visa appears in a resume bullet', () => {
  const m = {
    experience_bullets: { current: ['Led migration to H1B-style pipelines'] },
    tailoring_notes:    'fine',
  };
  const leaks = scanForVisaLeakage(candidateFacingMaterialsText(m));
  assert.ok(leaks.length > 0, 'bullet H1B mention must be caught');
});

test('shape-tolerance: missing fields do not throw', () => {
  assert.equal(candidateFacingMaterialsText(null),      '');
  assert.equal(candidateFacingMaterialsText({}),        '');
  assert.equal(candidateFacingMaterialsText({ experience_bullets: 'not-an-object' }), '');
});
