// Regression for bug 2: extractCompanyFromUrl must derive a proper company name from
// known ATS host URLs so jobs.company_name_raw is no longer "Unknown company".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCompanyFromUrl } from '../dist/core/jd_normalize.js';

test('greenhouse hosts → titlecased slug', () => {
  assert.equal(extractCompanyFromUrl('https://job-boards.greenhouse.io/vercel/jobs/12345'),    'Vercel');
  assert.equal(extractCompanyFromUrl('https://job-boards.eu.greenhouse.io/polyai'),            'Polyai');
  assert.equal(extractCompanyFromUrl('https://boards.greenhouse.io/intercom/jobs/7'),          'Intercom');
});

test('ashby', () => {
  assert.equal(extractCompanyFromUrl('https://jobs.ashbyhq.com/notion/abc-123'),  'Notion');
  assert.equal(extractCompanyFromUrl('https://jobs.ashbyhq.com/elevenlabs'),      'Elevenlabs');
});

test('lever', () => {
  assert.equal(extractCompanyFromUrl('https://jobs.lever.co/huggingface/some-id'), 'Huggingface');
});

test('workday tenant from subdomain', () => {
  assert.equal(extractCompanyFromUrl('https://acme.wd5.myworkdayjobs.com/External_Career_Site'), 'Acme');
  assert.equal(extractCompanyFromUrl('https://nvidia.wd1.myworkdayjobs.com/NVIDIA'),             'Nvidia');
});

test('amazon + google fixed names', () => {
  assert.equal(extractCompanyFromUrl('https://www.amazon.jobs/en/jobs/1234'),                     'Amazon');
  assert.equal(extractCompanyFromUrl('https://www.google.com/about/careers/applications/jobs/5'), 'Google');
});

test('hyphenated + underscored slugs → Title Case Words', () => {
  assert.equal(extractCompanyFromUrl('https://jobs.ashbyhq.com/eleven-labs/abc'), 'Eleven Labs');
  assert.equal(extractCompanyFromUrl('https://jobs.lever.co/two_words/abc'),      'Two Words');
});

test('unknown host returns null (so og:site_name fallback can take over)', () => {
  assert.equal(extractCompanyFromUrl('https://example.com/jobs'),           null);
  assert.equal(extractCompanyFromUrl('https://random-startup.io/careers'),  null);
});

test('robust on malformed input', () => {
  assert.equal(extractCompanyFromUrl(''),         null);
  assert.equal(extractCompanyFromUrl(null),       null);
  assert.equal(extractCompanyFromUrl(undefined),  null);
  assert.equal(extractCompanyFromUrl('not a url'),null);
});
