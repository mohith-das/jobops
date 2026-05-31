// Regression for the apply_prefill mapping bug:
//   A "Where did you first hear about this role?" field was being auto-filled with the
//   candidate's resume tagline because the old matcher used loose substring matching
//   (the label contained the substring "about"). The fix replaces substring matching
//   with confidence-based classification + an explicit allowlist; ANY unrecognised
//   field stays blank/user_must_provide, never gets tagline/cover/summary text dumped
//   into it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyField, draftValue } from '../dist/mcp/tools/apply_prefill.js';

// A representative profile.
const IDENTITY = {
  full_name:     'Casey Riley',
  email:         'casey@example.com',
  phone:         '+1 555 0100',
  linkedin:      'linkedin.com/in/casey',
  github:        'github.com/casey',
  portfolio_url: 'https://casey.dev',
  location:      'Austin, TX',
};

/** Helper to build a DetectedRaw — defaults to a generic <input type="text">. */
function f(over) {
  return {
    selector:     '#x', label: '', name: '', autocomplete: '', type: 'text',
    required: false, tag: 'input', ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidently-mappable fields STILL fill correctly.

test('email field fills from identity.email (autocomplete signal)', () => {
  const r = draftValue(f({ autocomplete: 'email', label: 'Email *' }), IDENTITY);
  assert.equal(r.classification.kind, 'email');
  assert.equal(r.draft_value, 'casey@example.com');
  assert.equal(r.source, 'profile');
});

test('email field fills from input type=email', () => {
  const r = draftValue(f({ type: 'email', name: 'app_email' }), IDENTITY);
  assert.equal(r.classification.kind, 'email');
  assert.equal(r.draft_value, 'casey@example.com');
});

test('phone field fills (type=tel signal)', () => {
  const r = draftValue(f({ type: 'tel', label: 'Phone *' }), IDENTITY);
  assert.equal(r.classification.kind, 'phone');
  assert.equal(r.draft_value, '+1 555 0100');
});

test('first_name + last_name split correctly', () => {
  const fn = draftValue(f({ autocomplete: 'given-name', label: 'First Name *' }), IDENTITY);
  const ln = draftValue(f({ autocomplete: 'family-name', label: 'Last Name *' }), IDENTITY);
  assert.equal(fn.draft_value, 'Casey');
  assert.equal(ln.draft_value, 'Riley');
});

test('LinkedIn field fills from identity.linkedin', () => {
  const r = draftValue(f({ name: 'linkedin', label: 'LinkedIn Profile' }), IDENTITY);
  assert.equal(r.classification.kind, 'linkedin');
  assert.equal(r.draft_value, 'linkedin.com/in/casey');
});

test('GitHub field fills', () => {
  const r = draftValue(f({ label: 'GitHub' }), IDENTITY);
  assert.equal(r.classification.kind, 'github');
  assert.equal(r.draft_value, 'github.com/casey');
});

test('city field fills from identity.location (whole-word label)', () => {
  const r = draftValue(f({ label: 'City', name: 'city' }), IDENTITY);
  assert.equal(r.classification.kind, 'city');
  assert.equal(r.draft_value, 'Austin, TX');
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BUG REGRESSION: free-text questions are NEVER filled with tagline/materials.

test('"Where did you first hear about this role?" stays user_must_provide', () => {
  // Old bug: label contains "about" → matched tagline. Must NOT fire now.
  const r = draftValue(f({ label: 'Where did you first hear about this role?' }), IDENTITY);
  assert.equal(r.classification.kind, null, `expected null, got ${r.classification.kind}`);
  assert.equal(r.draft_value, '');
  assert.equal(r.source, 'user_must_provide');
});

test('"Why are you interested in this role?" stays blank', () => {
  const r = draftValue(f({ label: 'Why are you interested in this role?', name: 'why_interested' }), IDENTITY);
  assert.equal(r.classification.kind, null);
  assert.equal(r.draft_value, '');
});

test('"Tell us about a project you shipped" stays blank', () => {
  const r = draftValue(f({ label: 'Tell us about a project you shipped', name: 'project' }), IDENTITY);
  assert.equal(r.classification.kind, null);
  assert.equal(r.draft_value, '');
});

test('"Cover letter" free-text question stays blank — uploaded as a file', () => {
  // Even if the label literally says "Cover letter" — we do not paste prose here.
  // The user's cover_url is exposed at the top level for download + upload.
  const r = draftValue(f({ label: 'Cover letter', name: 'cover_letter' }), IDENTITY);
  assert.equal(r.classification.kind, null);
  assert.equal(r.draft_value, '');
});

test('any textarea stays blank, even if its label sounds mappable', () => {
  // A textarea labelled "Email me back with details" should NOT get auto-filled.
  const r = draftValue(f({ tag: 'textarea', label: 'Email me back with details' }), IDENTITY);
  assert.equal(r.classification.kind, null);
  assert.equal(r.draft_value, '');
});

test('any <select> dropdown stays blank', () => {
  const r = draftValue(f({ tag: 'select', label: 'How did you hear about us?', name: 'source' }), IDENTITY);
  assert.equal(r.classification.kind, null);
  assert.equal(r.draft_value, '');
});

// ─────────────────────────────────────────────────────────────────────────────
// Visa / work-auth — always blocked, regardless of other signals.

test('visa-sponsorship Y/N stays blank', () => {
  const r = draftValue(f({ label: 'Will you now or in the future require visa sponsorship?', name: 'visa_sponsorship' }), IDENTITY);
  assert.equal(r.classification.kind, null);
  assert.match(r.classification.reason, /visa/);
  assert.equal(r.draft_value, '');
});

test('work-authorization field stays blank', () => {
  const r = draftValue(f({ label: 'Are you legally authorized to work in the United States?', name: 'work_authorization' }), IDENTITY);
  assert.equal(r.classification.kind, null);
  assert.equal(r.draft_value, '');
});

test('country-of-residence dropdown stays blank', () => {
  const r = draftValue(f({ tag: 'select', label: 'Country of residence', name: 'country_of_residence' }), IDENTITY);
  assert.equal(r.classification.kind, null);
  assert.equal(r.draft_value, '');
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-confusion tests — fields that contain "name" or "email" as substrings of
// OTHER concepts must NOT be filled with the user's identity.

test('"Company name" field does NOT fill with the candidate\'s full name', () => {
  const r = draftValue(f({ label: 'Company name', name: 'company_name' }), IDENTITY);
  assert.equal(r.classification.kind, null,
    `expected null; got ${r.classification.kind} → value="${r.draft_value}"`);
  assert.equal(r.draft_value, '');
});

test('"Manager\'s name" field does NOT fill with the candidate\'s full name', () => {
  const r = draftValue(f({ label: "Manager's name", name: 'manager_name' }), IDENTITY);
  assert.equal(r.classification.kind, null);
  assert.equal(r.draft_value, '');
});

test('"Reference email" field does NOT fill with the candidate\'s email', () => {
  // Plain type=text + label "Reference email" — without type=email signal, our rule
  // requires whole-word "email" label. "Reference email" is a stretch — better to
  // leave for user. Confirms we don't naively grab any field with "email" in it.
  const r = draftValue(f({ label: 'Reference email', name: 'reference_email' }), IDENTITY);
  assert.equal(r.classification.kind, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile-missing handling.

test('missing profile field → user_must_provide (not "profile" with empty value)', () => {
  const sparse = { full_name: 'Casey Riley' };  // no email, no linkedin, etc.
  const r = draftValue(f({ type: 'email', label: 'Email' }), sparse);
  assert.equal(r.classification.kind, 'email', 'classification still email');
  assert.equal(r.draft_value, '');
  assert.equal(r.source, 'user_must_provide',
    'when classification matches but the value is empty, source must be user_must_provide');
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyField is exported and usable independently.

test('classifyField is a pure function', () => {
  const c = classifyField(f({ type: 'email', name: 'email_address' }));
  assert.equal(c.kind, 'email');
  assert.match(c.reason, /email/);
});
