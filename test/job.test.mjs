import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeJob, NO_COUNTRY } from '../src/job.mjs';

const base = { external_id: 'e1', title: 'Cook', company: 'Acme', apply_url: 'https://x.test/apply?utm_source=a&id=1' };
const full = { tier: 'full', us_only: true };
const facts = { tier: 'facts_only', us_only: true };

test('required fields: external_id, title, company, https apply_url', () => {
  assert.equal(finalizeJob(base, full).ok, true);
  for (const missing of ['external_id', 'title', 'company', 'apply_url']) {
    const r = finalizeJob({ ...base, [missing]: '' }, full);
    assert.equal(r.ok, false, missing);
  }
  assert.equal(finalizeJob({ ...base, apply_url: 'http://x.test/a' }, full).ok, false, 'http apply_url');
  assert.equal(finalizeJob({ ...base, apply_url: 'https://u:p@x.test/a' }, full).ok, false);
});

test('apply_url loses utm_* but keeps real parameters', () => {
  assert.equal(finalizeJob(base, full).job.apply_url, 'https://x.test/apply?id=1');
});

test('description: never present for facts_only, even when the connector produced one', () => {
  const raw = { ...base, description: '<p>Secret text</p>' };
  const f = finalizeJob(raw, facts).job;
  assert.ok(!('description' in f));
  assert.ok(!JSON.stringify(f).includes('Secret text'));
  assert.equal(finalizeJob(raw, full).job.description, '<p>Secret text</p>');
});

test('description is capped at 50,000 characters', () => {
  assert.equal(finalizeJob({ ...base, description: 'x'.repeat(70_000) }, full).job.description.length, 50_000);
});

test('country: unknown + us_only -> ZZ; unknown + not us_only -> omitted; never guessed', () => {
  assert.equal(finalizeJob(base, full).job.loc_country, NO_COUNTRY);
  assert.ok(!('loc_country' in finalizeJob(base, { tier: 'full', us_only: false }).job));
  assert.equal(finalizeJob({ ...base, loc_country: 'Germany' }, full).job.loc_country, 'DE');
  assert.equal(finalizeJob({ ...base, loc_country: 'us' }, full).job.loc_country, 'US');
});

test('region/postal: a US state code implies US; a non-US country drops them', () => {
  const us = finalizeJob({ ...base, loc_region: 'tx', loc_postal: '78701' }, full).job;
  assert.equal(us.loc_region, 'TX');
  assert.equal(us.loc_country, 'US');
  assert.equal(us.loc_postal, '78701');
  const ca = finalizeJob({ ...base, loc_region: 'TX', loc_country: 'CA' }, full).job;
  assert.ok(!('loc_region' in ca));
  assert.equal(ca.loc_country, 'CA');
  assert.ok(!('loc_region' in finalizeJob({ ...base, loc_region: 'ON' }, full).job), 'not a US state');
  assert.ok(!('loc_postal' in finalizeJob({ ...base, loc_region: 'TX', loc_postal: 'ABC' }, full).job));
});

test('enums are checked, salary only when valid', () => {
  const j = finalizeJob({ ...base, work_mode: 'remote', job_type: 'Full time', salary_min: 20, salary_max: 25, salary_period: 'hour' }, full).job;
  assert.equal(j.work_mode, 'remote');
  assert.equal(j.job_type, 'full-time');
  assert.deepEqual([j.salary_min, j.salary_max, j.salary_period, j.salary_currency], [20, 25, 'hour', 'USD']);
  const bad = finalizeJob({ ...base, work_mode: 'wfh', job_type: 'weird', salary_min: 5, salary_max: 4, salary_period: 'hour' }, full).job;
  assert.ok(!('work_mode' in bad) && !('job_type' in bad) && !('salary_min' in bad));
});

test('only known fields are sent; text is plain and bounded; dates are ISO', () => {
  const j = finalizeJob({ ...base, title: '  <b>Cook</b>  &amp; Prep ', evil_field: 'x', posted_at: 'Mon, 05 Oct 2026 10:00:00 GMT', experience_months: 12, category: 'Kitchen' }, full).job;
  assert.equal(j.title, 'Cook & Prep');
  assert.ok(!('evil_field' in j));
  assert.equal(j.posted_at, '2026-10-05T10:00:00.000Z');
  assert.equal(j.experience_months, 12);
  assert.equal(j.category, 'Kitchen');
  assert.equal(finalizeJob({ ...base, title: 'x'.repeat(500) }, full).job.title.length, 300);
});
