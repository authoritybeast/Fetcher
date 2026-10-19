import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectors } from '../src/connectors/index.mjs';
import { finalizeJob } from '../src/job.mjs';
import { HttpError, RateLimitError, RobotsDisallowedError } from '../src/http.mjs';
import { collect, httpFor, sourceOf, startFakeServer } from '../test-support/fake-server.mjs';

const fx = (name) => readFileSync(new URL(`../test-support/fixtures/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fx(name));
const xml = (name) => ({ headers: { 'content-type': 'application/xml' }, body: fx(name) });

/** Run one connector against a fake server. */
async function runConnector(kind, config, handler, extra = {}, env = {}) {
  const server = await startFakeServer(handler);
  try {
    const { http, clock } = httpFor(server, extra.http);
    const source = sourceOf(kind, config, extra.source);
    const out = await collect(connectors[kind].fetchJobs({ source, env, http, log: console, expired: extra.expired }));
    return { ...out, server, clock, source };
  } finally {
    await server.close();
  }
}
const final = (raw, source) => {
  const r = finalizeJob(raw, source);
  assert.equal(r.ok, true, JSON.stringify(raw));
  return r.job;
};

test('every kind has a connector, and jsonld is a stub that refuses', async () => {
  assert.deepEqual(Object.keys(connectors).sort(), ['arbeitnow', 'ashby', 'greenhouse', 'json_feed', 'jsonld', 'lever', 'recruitee', 'remoteok', 'remotive', 'rss', 'smartrecruiters', 'usajobs']);
  await assert.rejects(collect(connectors.jsonld.fetchJobs({ source: sourceOf('jsonld', {}) })), /not implemented yet/);
});

test('greenhouse: URL, mapping, escaped HTML decoded, complete', async () => {
  const r = await runConnector('greenhouse', { board_token: 'acme', company_name: 'Acme Diner' }, () => ({ body: json('greenhouse.json') }));
  assert.equal(r.server.requests[0].host, 'boards-api.greenhouse.io');
  assert.equal(r.server.requests[0].path, '/v1/boards/acme/jobs?content=true');
  assert.equal(r.jobs.length, 2);
  const a = final(r.jobs[0], r.source);
  assert.deepEqual([a.external_id, a.title, a.company, a.loc_city, a.loc_region, a.loc_country], ['4001', 'Line Cook', 'Acme Diner', 'Austin', 'TX', 'US']);
  assert.equal(a.apply_url, 'https://boards.example.test/acme/jobs/4001?gh_jid=4001', 'utm_* removed');
  assert.equal(a.description, '<p>Cook &amp; prep in a busy kitchen.</p>');
  assert.equal(a.category, 'Kitchen');
  const b = final(r.jobs[1], r.source);
  assert.equal(b.work_mode, 'remote');
  assert.equal(b.loc_country, 'US');
  assert.equal(b.company, 'Acme Diner', 'config.company_name wins');
  assert.deepEqual(r.result, { complete: true, truncated: false });
});

test('greenhouse: falls back to the source name, and a board that says "more than returned" is not complete', async () => {
  const data = json('greenhouse.json');
  data.meta.total = 99;
  const r = await runConnector('greenhouse', { board_token: 'acme' }, () => ({ body: data }));
  assert.equal(final(r.jobs[1], r.source).company, 'Test Source');
  assert.deepEqual(r.result, { complete: false, truncated: true });
});

test('greenhouse: max_jobs cap makes the run incomplete', async () => {
  const r = await runConnector('greenhouse', { board_token: 'acme', max_jobs: 1 }, () => ({ body: json('greenhouse.json') }));
  assert.equal(r.jobs.length, 1);
  assert.deepEqual(r.result, { complete: false, truncated: true });
});

test('connectors reject a bad identifier before any request (it becomes part of a URL)', async () => {
  for (const [kind, config] of [['greenhouse', { board_token: '../admin' }], ['lever', { company: 'a/b' }], ['ashby', { board: 'x?y=1' }], ['smartrecruiters', { company_id: '' }], ['recruitee', { company: 'evil.com/x#' }], ['recruitee', { company: 'a.b' }]]) {
    const server = await startFakeServer(() => ({ body: [] }));
    try {
      await assert.rejects(collect(connectors[kind].fetchJobs({ source: sourceOf(kind, config), env: {}, http: httpFor(server).http })), /config:/, kind);
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  }
});

test('lever: URL, mapping (country, workplace, salary, description parts), EU host', async () => {
  const r = await runConnector('lever', { company: 'beanco', company_name: 'Bean Co' }, () => ({ body: json('lever.json') }));
  assert.equal(r.server.requests[0].host, 'api.lever.co');
  assert.equal(r.server.requests[0].path, '/v0/postings/beanco?mode=json&skip=0&limit=100');
  const a = final(r.jobs[0], r.source);
  assert.deepEqual([a.title, a.company, a.loc_city, a.loc_region, a.loc_country, a.work_mode, a.job_type], ['Barista', 'Bean Co', 'Seattle', 'WA', 'US', 'onsite', 'part-time']);
  assert.deepEqual([a.salary_min, a.salary_max, a.salary_period, a.salary_currency], [18, 22, 'hour', 'USD']);
  assert.equal(a.apply_url, 'https://jobs.example.test/beanco/11111111-aaaa-4aaa-8aaa-000000000001/apply');
  assert.equal(a.description, "<div>Pour coffee.</div><h3>What you&#39;ll do</h3><ul><li>Brew</li><li>Smile</li></ul><div>Equal opportunity.</div>");
  assert.equal(a.category, 'Retail');
  const b = final(r.jobs[1], r.source);
  assert.equal(b.loc_country, 'CA', 'explicit country wins');
  assert.ok(!('work_mode' in b), '"unspecified" is not a work mode');
  assert.deepEqual(r.result, { complete: true, truncated: false });
  const eu = await runConnector('lever', { company: 'beanco', eu: true }, () => ({ body: [] }));
  assert.equal(eu.server.requests[0].host, 'api.eu.lever.co');
});

test('lever: pagination follows skip/limit, stops on a short page; page and job caps make it incomplete', async () => {
  const mk = (n, from) => Array.from({ length: n }, (_, i) => ({ id: `id-${from + i}`, text: 'T', categories: { location: 'Austin, TX' }, hostedUrl: 'https://j.example.test/x', applyUrl: 'https://j.example.test/a' }));
  const pager = ({ path }) => {
    const skip = Number(/skip=(\d+)/.exec(path)[1]);
    return { body: skip === 0 ? mk(100, 0) : skip === 100 ? mk(100, 100) : mk(20, 200) };
  };
  const all = await runConnector('lever', { company: 'big' }, pager);
  assert.equal(all.jobs.length, 220);
  assert.deepEqual(all.server.requests.map((q) => /skip=(\d+)/.exec(q.path)[1]), ['0', '100', '200']);
  assert.equal(all.result.complete, true);
  const pages = await runConnector('lever', { company: 'big', max_pages: 2 }, pager);
  assert.equal(pages.jobs.length, 200);
  assert.deepEqual(pages.result, { complete: false, truncated: true });
  assert.equal(pages.server.requests.length, 2);
  const jobs = await runConnector('lever', { company: 'big', max_jobs: 150 }, pager);
  assert.equal(jobs.jobs.length, 150);
  assert.equal(jobs.result.complete, false);
  const lifted = await runConnector('lever', { company: 'big', max_pages: 500 }, pager);
  assert.equal(lifted.result.complete, true, 'max_pages cannot raise the default of 50 but 3 pages are well below it');
  const exactly = await runConnector('lever', { company: 'exact' }, ({ path }) => ({ body: /skip=0/.test(path) ? mk(100, 0) : [] }));
  assert.equal(exactly.result.complete, true, 'a full page followed by an empty page is the end');
});

test('lever: the hard page cap is 50 even when the list never ends', async () => {
  const endless = ({ path }) => ({ body: Array.from({ length: 100 }, (_, i) => ({ id: `${/skip=(\d+)/.exec(path)[1]}-${i}`, text: 'T', hostedUrl: 'https://j.example.test/x' })) });
  const r = await runConnector('lever', { company: 'endless', max_jobs: 20000 }, endless);
  assert.equal(r.server.requests.length, 50);
  assert.deepEqual(r.result, { complete: false, truncated: true });
});

test('ashby: URL with includeCompensation, mapping, unlisted skipped, salary from "1 HOUR"', async () => {
  const r = await runConnector('ashby', { board: 'zipco' }, () => ({ body: json('ashby.json') }));
  assert.equal(r.server.requests[0].path, '/posting-api/job-board/zipco?includeCompensation=true');
  assert.equal(r.jobs.length, 1, 'isListed:false is skipped');
  const a = final(r.jobs[0], r.source);
  assert.deepEqual([a.title, a.loc_city, a.loc_region, a.loc_country, a.job_type], ['Delivery Driver', 'Denver', 'CO', 'US', 'part-time']);
  assert.deepEqual([a.salary_min, a.salary_max, a.salary_period], [20, 24, 'hour']);
  assert.equal(a.description, '<p>Deliver.</p>');
  assert.equal(a.company, 'Test Source');
  assert.deepEqual(r.result, { complete: true, truncated: false });
});

test('smartrecruiters: list paging, detail only for tier full, description/apply url from the detail', async () => {
  const handler = ({ path }) => {
    if (/\/postings\?/.test(path)) return { body: json('smartrecruiters-list.json') };
    if (/\/postings\/7440000000000001$/.test(path)) return { body: json('smartrecruiters-detail.json') };
    return undefined;
  };
  const full = await runConnector('smartrecruiters', { company_id: 'BoxCo' }, handler);
  assert.deepEqual(full.server.requests.map((q) => q.path), ['/v1/companies/BoxCo/postings?limit=100&offset=0', '/v1/companies/BoxCo/postings/7440000000000001']);
  const a = final(full.jobs[0], full.source);
  assert.deepEqual([a.title, a.company, a.loc_city, a.loc_region, a.loc_country, a.job_type, a.category], ['Warehouse Associate', 'Box Co', 'Columbus', 'OH', 'US', 'full-time', 'Operations']);
  assert.equal(a.apply_url, 'https://jobs.example.test/BoxCo/7440000000000001-warehouse-associate?oga=true');
  assert.match(a.description, /^<h3>Company<\/h3><p>We ship boxes\.<\/p><h3>Job<\/h3><p>Lift boxes\.<\/p>/);
  assert.deepEqual(full.result, { complete: true, truncated: false });

  const facts = await runConnector('smartrecruiters', { company_id: 'BoxCo' }, handler, { source: { tier: 'facts_only' } });
  assert.equal(facts.server.requests.length, 1, 'no detail requests for facts_only');
  const f = final(facts.jobs[0], facts.source);
  assert.equal(f.apply_url, 'https://jobs.smartrecruiters.com/BoxCo/7440000000000001');
  assert.ok(!('description' in f));
});

test('smartrecruiters: offset paging up to totalFound; a vanished posting makes the run incomplete', async () => {
  const item = (i) => ({ id: `p${i}`, name: 'N', company: { identifier: 'BoxCo', name: 'Box Co' }, location: { country: 'us' } });
  const paged = ({ path }) => {
    const offset = Number(/offset=(\d+)/.exec(path)?.[1]);
    if (Number.isNaN(offset)) return { body: { id: 'x', jobAd: { sections: {} } } };
    return { body: { offset, limit: 100, totalFound: 150, content: Array.from({ length: offset === 0 ? 100 : 50 }, (_, i) => item(offset + i)) } };
  };
  const r = await runConnector('smartrecruiters', { company_id: 'BoxCo' }, paged, { source: { tier: 'facts_only' } });
  assert.equal(r.jobs.length, 150);
  assert.equal(r.result.complete, true);
  const gone = await runConnector('smartrecruiters', { company_id: 'BoxCo' }, ({ path }) => (/\/postings\/p/.test(path) ? { status: 404 } : paged({ path })), { source: { tier: 'full' }, http: { retries: 0 } });
  assert.equal(gone.result.complete, false);
});

test('recruitee: host from the validated subdomain, mapping, drafts skipped', async () => {
  const r = await runConnector('recruitee', { company: 'shopco' }, () => ({ body: json('recruitee.json') }));
  assert.equal(r.server.requests[0].host, 'shopco.recruitee.com');
  assert.equal(r.server.requests[0].path, '/api/offers/');
  assert.equal(r.jobs.length, 1);
  const a = final(r.jobs[0], r.source);
  assert.deepEqual([a.title, a.company, a.loc_city, a.loc_region, a.loc_postal, a.loc_country, a.work_mode, a.job_type], ['Shift Lead', 'Shop Co', 'Miami', 'FL', '33101', 'US', 'hybrid', 'full-time']);
  assert.deepEqual([a.salary_min, a.salary_max, a.salary_period], [45000, 55000, 'year']);
  assert.equal(a.description, '<p>Lead the shift.</p><p>2 years experience.</p>');
  assert.equal(r.result.complete, true);
});

const USAJOBS_ENV = { USAJOBS_API_KEY: 'key-for-tests-only', USAJOBS_EMAIL: 'ops@example.test' };

test('usajobs: headers per the docs, query from config, mapping, paging by NumberOfPages', async () => {
  const r = await runConnector('usajobs', { keyword: 'ranger', location: 'Utah', organization: 'INT' }, () => ({ body: json('usajobs.json') }), {}, USAJOBS_ENV);
  const q = r.server.requests[0];
  assert.equal(q.host, 'data.usajobs.gov');
  assert.equal(q.path, '/api/search?Keyword=ranger&LocationName=Utah&Organization=INT&ResultsPerPage=250&Page=1');
  assert.equal(q.headers['user-agent'], 'ops@example.test');
  assert.equal(q.headers['authorization-key'], 'key-for-tests-only');
  const a = final(r.jobs[0], r.source);
  assert.deepEqual([a.external_id, a.title, a.company, a.loc_country, a.loc_region, a.job_type, a.category], ['800000001', 'Park Ranger', 'National Park Service', 'US', 'UT', 'full-time', 'Natural Resources']);
  assert.deepEqual([a.salary_min, a.salary_max, a.salary_period, a.salary_currency], [46000, 61000, 'year', 'USD']);
  assert.equal(a.apply_url, 'https://www.usajobs.example.test/GetJob/ApplyOnline/800000001');
  assert.equal(a.description, '<p>Protect the park.</p><p>Help visitors.</p><h3>Major duties</h3><ul><li>Patrol trails</li><li>Answer questions &lt;b&gt;kindly&lt;/b&gt;</li></ul><h3>Qualifications</h3><p>One year of experience.</p>');
  assert.deepEqual(r.result, { complete: true, truncated: false });

  const two = json('usajobs.json');
  two.SearchResult.UserArea.NumberOfPages = 3;
  const paged = await runConnector('usajobs', { max_pages: 2 }, () => ({ body: two }), {}, USAJOBS_ENV);
  assert.equal(paged.server.requests.length, 2, 'max_pages lowers the cap');
  assert.deepEqual(paged.result, { complete: false, truncated: true });
});

test('usajobs: without the secrets it fails before any request', async () => {
  const server = await startFakeServer(() => ({ body: {} }));
  try {
    await assert.rejects(collect(connectors.usajobs.fetchJobs({ source: sourceOf('usajobs', {}), env: {}, http: httpFor(server).http })), /USAJOBS_API_KEY and USAJOBS_EMAIL/);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('remoteok: skips the legal notice at index 0, remote, salary only when given, source_url set', async () => {
  const r = await runConnector('remoteok', {}, () => ({ body: json('remoteok.json') }));
  assert.equal(r.server.requests[0].path, '/api');
  assert.equal(r.jobs.length, 2);
  const a = final(r.jobs[0], r.source);
  assert.deepEqual([a.external_id, a.title, a.company, a.work_mode, a.loc_country], ['99001', 'Remote Support Specialist', 'Cloud Cafe', 'remote', 'US']);
  assert.equal(a.source_url, 'https://remoteok.example.test/remote-jobs/remote-support-99001');
  assert.equal(a.apply_url, 'https://remoteok.example.test/l/99001');
  assert.deepEqual([a.salary_min, a.salary_max, a.salary_period], [40000, 52000, 'year']);
  const b = final(r.jobs[1], r.source);
  assert.equal(b.apply_url, 'https://remoteok.example.test/remote-jobs/no-salary-99002', 'job page when there is no separate apply url');
  assert.ok(!('salary_min' in b));
  assert.equal(b.loc_country, 'ZZ', '"Worldwide" is not a country (us_only source)');
  assert.equal(r.result.complete, true);
});

test('remotive: one request, mapping, and it refuses a schedule above 4 fetches a day', async () => {
  const ok = await runConnector('remotive', {}, () => ({ body: json('remotive.json') }), { source: { fetch_interval_minutes: 360 } });
  assert.equal(ok.server.requests.length, 1);
  assert.equal(ok.server.requests[0].path, '/api/remote-jobs');
  const a = final(ok.jobs[0], ok.source);
  assert.deepEqual([a.title, a.company, a.loc_country, a.work_mode, a.job_type, a.category], ['Support Agent', 'Helpful Inc', 'US', 'remote', 'full-time', 'Customer Service']);
  assert.ok(!('salary_min' in a), 'free-text salary is not parsed');
  assert.equal(final(ok.jobs[1], ok.source).loc_country, 'ZZ');
  assert.equal(ok.result.complete, true);

  for (const minutes of [60, 359, undefined, 'x']) {
    const server = await startFakeServer(() => ({ body: json('remotive.json') }));
    try {
      await assert.rejects(collect(connectors.remotive.fetchJobs({ source: sourceOf('remotive', {}, { fetch_interval_minutes: minutes }), env: {}, http: httpFor(server).http })), /4 fetches a day/, String(minutes));
      assert.equal(server.requests.length, 0, 'not a single request');
    } finally {
      await server.close();
    }
  }
  const windowed = await runConnector('remotive', { limit: 1 }, () => ({ body: json('remotive.json') }), { source: { fetch_interval_minutes: 1440 } });
  assert.equal(windowed.server.requests[0].path, '/api/remote-jobs?limit=1');
  assert.equal(windowed.result.complete, false, 'a limited list is a window');
});

test('arbeitnow: follows links.next on the same host, epoch seconds, non-US stays unknown (ZZ)', async () => {
  const r = await runConnector('arbeitnow', {}, ({ path }) => ({ body: json(/page=2/.test(path) ? 'arbeitnow-2.json' : 'arbeitnow-1.json') }));
  assert.deepEqual(r.server.requests.map((q) => q.path), ['/api/job-board-api', '/api/job-board-api?page=2']);
  assert.equal(r.jobs.length, 2);
  const a = final(r.jobs[0], r.source);
  assert.deepEqual([a.external_id, a.title, a.company, a.loc_country, a.job_type], ['kellner-berlin-1', 'Kellner (m/w/d)', 'Cafe Berlin', 'ZZ', 'full-time']);
  assert.equal(a.posted_at, new Date(1790000000 * 1000).toISOString());
  assert.equal(final(r.jobs[1], r.source).work_mode, 'remote');
  assert.deepEqual(r.result, { complete: true, truncated: false });
});

test('arbeitnow: a "next" link to another host is never followed', async () => {
  const data = json('arbeitnow-1.json');
  data.links.next = 'https://evil.example.test/steal?page=2';
  const r = await runConnector('arbeitnow', {}, () => ({ body: data }));
  assert.equal(r.server.requests.length, 1);
  assert.deepEqual(r.result, { complete: false, truncated: true });
});

test('rss: RSS 2.0 mapping, CDATA vs escaped HTML, company_from, salary only in the clear shape, DOCTYPE entities not expanded', async () => {
  const feed = (config) => runConnector('rss', { url: 'https://feed.example.test/jobs.xml', ...config }, ({ path }) => (path === '/robots.txt' ? { status: 404 } : xml('feed.rss.xml')));
  const r = await feed({ company_from: 'title_prefix', location_from: 'location', default_country: 'US' });
  assert.equal(r.jobs.length, 3);
  const a = final(r.jobs[0], r.source);
  assert.deepEqual([a.external_id, a.title, a.company, a.category], ['job-1', 'Bartender & Server', 'Brew House', 'Hospitality']);
  assert.equal(a.apply_url, 'https://feed.example.test/jobs/bartender-1', 'utm removed');
  assert.deepEqual([a.loc_city, a.loc_region, a.loc_country], ['Portland', 'OR', 'US']);
  assert.deepEqual([a.salary_min, a.salary_max, a.salary_period], [20, 25, 'hour']);
  assert.equal(a.description, '<p>Pour drinks. $20 - $25 per hour plus tips. &amp; more</p>', 'CDATA is kept as is');
  assert.equal(r.jobs[1].description, '<p>Escaped description</p>', 'escaped HTML is decoded');
  assert.equal(finalizeJob(r.jobs[1], r.source).ok, false, 'an http:// link cannot be an apply_url');
  assert.equal(final(r.jobs[2], r.source).company, 'Test Source', 'no company_from match -> the source name');
  assert.deepEqual(r.result, { complete: false, truncated: false }, 'a feed is a window: never complete by default');

  const author = await feed({ company_from: 'author' });
  assert.equal(final(author.jobs[2], author.source).company, 'Fast Couriers');
  const fixed = await feed({ company_from: 'fixed:Acme Staffing' });
  assert.equal(final(fixed.jobs[0], fixed.source).company, 'Acme Staffing');
  assert.equal((await feed({ fixed_company: 'Pinned Co' })).jobs[0].company, 'Pinned Co');
  const asserted = await feed({ complete: true });
  assert.deepEqual(asserted.result, { complete: true, truncated: false }, 'the admin can assert a feed is the whole listing');
  const capped = await feed({ complete: true, max_jobs: 2 });
  assert.deepEqual(capped.result, { complete: false, truncated: true });
});

test('rss: Atom entries (alternate link, author name, summary html)', async () => {
  const r = await runConnector('rss', { url: 'https://feed.example.test/atom.xml', company_from: 'author' }, ({ path }) => (path === '/robots.txt' ? { status: 404 } : xml('feed.atom.xml')));
  const a = final(r.jobs[0], r.source);
  assert.deepEqual([a.external_id, a.title, a.company, a.apply_url, a.description], ['tag:feed.example.test,2026:job-77', 'Night Auditor', 'Hotel Moon', 'https://feed.example.test/jobs/77', '<p>Night shift</p>']);
  assert.equal(a.posted_at, '2026-10-06T08:00:00.000Z');
});

test('rss: robots.txt disallow, bad XML, non-feed XML and a missing url', async () => {
  await assert.rejects(runConnector('rss', { url: 'https://feed.example.test/jobs.xml' }, ({ path }) => (path === '/robots.txt' ? { body: 'User-agent: *\nDisallow: /' } : xml('feed.rss.xml'))), RobotsDisallowedError);
  await assert.rejects(runConnector('rss', { url: 'https://feed.example.test/j.xml' }, ({ path }) => (path === '/robots.txt' ? { status: 404 } : { headers: { 'content-type': 'application/xml' }, body: '<rss><channel><item></rss' })), HttpError);
  await assert.rejects(runConnector('rss', { url: 'https://feed.example.test/j.xml' }, ({ path }) => (path === '/robots.txt' ? { status: 404 } : { headers: { 'content-type': 'application/xml' }, body: '<html><body>nope</body></html>' })), /not an RSS or Atom feed/);
  await assert.rejects(runConnector('rss', {}, () => undefined), /config:/);
});

test('rss: an XML entity bomb does not expand', async () => {
  const bomb = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "${'x'.repeat(1000)}"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><rss><channel><item><title>&c;</title><link>https://feed.example.test/1</link><guid>1</guid></item></channel></rss>`;
  const r = await runConnector('rss', { url: 'https://feed.example.test/b.xml' }, ({ path }) => (path === '/robots.txt' ? { status: 404 } : { headers: { 'content-type': 'application/xml' }, body: bomb }));
  assert.ok(r.jobs[0].title.length < 100, `title length ${r.jobs[0].title.length}`);
});

test('json_feed: dotted-path mapping, fixed values, no code evaluation, prototype keys ignored', async () => {
  const config = {
    url: 'https://feed.example.test/api/jobs',
    items_path: 'data.jobs',
    map: { external_id: 'ref', title: 'name', company: 'employer.name', apply_url: 'link', location: 'where', work_mode: 'mode', salary_min: 'pay.from', salary_max: 'pay.to', salary_period: 'pay.unit', description: 'html', posted_at: 'posted', __proto__: 'x', constructor: 'name' },
    fixed: { job_type: 'full-time' },
  };
  const r = await runConnector('json_feed', config, ({ path }) => (path === '/robots.txt' ? { status: 404 } : { body: json('feed.json') }));
  assert.equal(r.jobs.length, 2);
  const a = final(r.jobs[0], r.source);
  assert.deepEqual([a.external_id, a.title, a.company, a.loc_city, a.loc_region, a.loc_country, a.work_mode, a.job_type], ['J-1', 'Pizza Cook', 'Slice House', 'Chicago', 'IL', 'US', 'onsite', 'full-time']);
  assert.deepEqual([a.salary_min, a.salary_max, a.salary_period], [18, 21, 'hour']);
  assert.equal(a.posted_at, '2026-10-01T00:00:00.000Z');
  assert.equal(finalizeJob(r.jobs[1], r.source).ok, false, 'http:// apply_url');
  assert.ok(!('x' in r.jobs[0]) && Object.getPrototypeOf(r.jobs[0]) === Object.prototype);
  assert.deepEqual(r.result, { complete: false, truncated: false });
  const asserted = await runConnector('json_feed', { ...config, complete: true }, ({ path }) => (path === '/robots.txt' ? { status: 404 } : { body: json('feed.json') }));
  assert.equal(asserted.result.complete, true);
});

test('json_feed: next page on the same host only; robots.txt; bad items_path', async () => {
  const page = (n) => ({ data: { jobs: [{ ref: `P${n}`, name: 'T', link: 'https://feed.example.test/j' }] }, meta: { next: n < 3 ? `https://feed.example.test/api/jobs?page=${n + 1}` : null } });
  const base = { url: 'https://feed.example.test/api/jobs', items_path: 'data.jobs', next_url_path: 'meta.next', map: { external_id: 'ref', title: 'name', apply_url: 'link' } };
  const handler = ({ path }) => (path === '/robots.txt' ? { status: 404 } : { body: page(Number(/page=(\d)/.exec(path)?.[1] ?? 1)) });
  const r = await runConnector('json_feed', { ...base, complete: true }, handler);
  assert.equal(r.jobs.length, 3);
  assert.equal(r.result.complete, true);
  const capped = await runConnector('json_feed', { ...base, complete: true, max_pages: 2 }, handler);
  assert.deepEqual(capped.result, { complete: false, truncated: true });
  const offsite = await runConnector('json_feed', { ...base, complete: true }, ({ path }) => (path === '/robots.txt' ? { status: 404 } : { body: { data: { jobs: [{ ref: 'a', name: 'T', link: 'https://x.test/j' }] }, meta: { next: 'https://evil.example.test/p2' } } }));
  assert.equal(offsite.jobs.length, 1);
  assert.equal(offsite.result.complete, false);
  await assert.rejects(runConnector('json_feed', { ...base, items_path: 'nope.nope' }, handler), /items_path/);
  await assert.rejects(runConnector('json_feed', { ...base, url: 'https://feed.example.test/api/jobs' }, ({ path }) => (path === '/robots.txt' ? { body: 'User-agent: *\nDisallow: /api/' } : { body: page(1) })), RobotsDisallowedError);
});

test('every connector surfaces a rate limit as RateLimitError (the runner turns it into "partial")', async () => {
  const server = await startFakeServer(() => ({ status: 429, headers: { 'retry-after': '1' } }));
  try {
    const { http } = httpFor(server);
    await assert.rejects(collect(connectors.lever.fetchJobs({ source: sourceOf('lever', { company: 'x' }), env: {}, http })), RateLimitError);
  } finally {
    await server.close();
  }
});

test('a time budget that is used up stops paginating and marks the run incomplete', async () => {
  const r = await runConnector('lever', { company: 'x' }, () => ({ body: [] }), { expired: () => true });
  assert.deepEqual(r.result, { complete: false, truncated: true });
  assert.equal(r.server.requests.length, 0);
});
