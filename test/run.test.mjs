import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { main } from '../src/index.mjs';
import { runSource } from '../src/run.mjs';
import { createLogger } from '../src/log.mjs';
import { httpFor, sourceOf, startFakeServer } from '../test-support/fake-server.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`../test-support/fixtures/${name}`, import.meta.url), 'utf8'));
const TOKEN = 'tok_test_only_0123456789abcdef';
const URL_SECRET = 'https://secretproject.example.test/functions/v1/ingest';

function fakeApi({ batch, start, finish } = {}) {
  const calls = [];
  return {
    calls,
    due: async () => [],
    start: async (id, trigger) => {
      calls.push(['start', id, trigger]);
      if (start) throw start;
      return 'run-1';
    },
    batch: async (sid, rid, jobs) => {
      calls.push(['batch', sid, rid, jobs]);
      if (batch) return batch(jobs, calls.filter((c) => c[0] === 'batch').length);
      return { new: jobs.length, updated: 0, duplicates: 0, skipped: 0, errors: [] };
    },
    finish: async (rid, body) => {
      calls.push(['finish', rid, body]);
      if (finish) throw finish;
    },
  };
}
const logLines = () => {
  const lines = [];
  return { lines, log: createLogger({ secrets: [TOKEN, URL_SECRET], write: (l) => lines.push(l) }) };
};
const leverJob = (i, o = {}) => ({ id: `id-${i}`, text: `Job ${i}`, categories: { location: 'Austin, TX' }, hostedUrl: 'https://j.example.test/x', applyUrl: `https://j.example.test/a/${i}`, description: '<p>Body</p>', ...o });

async function run(source, handler, { api = fakeApi(), env = {}, dryRun = false, secrets = [TOKEN], httpOptions } = {}) {
  const server = await startFakeServer(handler);
  try {
    const { http } = httpFor(server, httpOptions);
    const { log, lines } = logLines();
    const res = await runSource({ source, api, env, http, log, dryRun, secrets });
    return { res, api, lines, server };
  } finally {
    await server.close();
  }
}
const finishOf = (api) => api.calls.find((c) => c[0] === 'finish')[2];
const sent = (api) => api.calls.filter((c) => c[0] === 'batch').flatMap((c) => c[3]);

test('happy path: start -> batch -> finish, trigger schedule, complete:true only when everything is clean', async () => {
  const { res, api } = await run(sourceOf('lever', { company: 'x' }), () => ({ body: [leverJob(1), leverJob(2)] }));
  assert.deepEqual(api.calls.map((c) => c[0]), ['start', 'batch', 'finish']);
  assert.deepEqual(api.calls[0], ['start', '00000000-0000-4000-8000-000000000001', 'schedule']);
  assert.equal(api.calls[1][2], 'run-1');
  assert.equal(sent(api).length, 2);
  const fin = finishOf(api);
  assert.equal(fin.status, 'ok');
  assert.equal(fin.complete, true);
  assert.equal(fin.error, undefined);
  assert.equal(fin.details.fetched, 2);
  assert.equal(res.status, 'ok');
});

test('an admin-requested run is started as "manual"', async () => {
  const { api } = await run(sourceOf('lever', { company: 'x' }, { requested: true }), () => ({ body: [leverJob(1)] }));
  assert.equal(api.calls[0][2], 'manual');
});

test('facts_only: no description is ever transmitted; full: it is', async () => {
  const facts = await run(sourceOf('lever', { company: 'x' }, { tier: 'facts_only' }), () => ({ body: [leverJob(1)] }));
  assert.equal(sent(facts.api).length, 1);
  assert.ok(!JSON.stringify(facts.api.calls).includes('Body'), 'the description text is nowhere in the payload');
  assert.ok(!('description' in sent(facts.api)[0]));
  const full = await run(sourceOf('lever', { company: 'x' }, { tier: 'full' }), () => ({ body: [leverJob(1)] }));
  assert.equal(sent(full.api)[0].description, '<p>Body</p>');
});

test('batches are split by count: 450 jobs -> 200 + 200 + 50, one run, all with the same run id', async () => {
  const page = (skip) => Array.from({ length: Math.max(0, Math.min(100, 450 - skip)) }, (_, i) => leverJob(skip + i));
  const { api } = await run(sourceOf('lever', { company: 'big' }), ({ path }) => ({ body: page(Number(/skip=(\d+)/.exec(path)[1])) }));
  const batches = api.calls.filter((c) => c[0] === 'batch');
  assert.deepEqual(batches.map((c) => c[3].length), [200, 200, 50]);
  assert.ok(batches.every((c) => c[2] === 'run-1'));
  assert.equal(finishOf(api).complete, true);
});

test('the same external_id twice in one run is sent once', async () => {
  const { api } = await run(sourceOf('lever', { company: 'x' }), () => ({ body: [leverJob(1), leverJob(1), leverJob(2)] }));
  assert.equal(sent(api).length, 2);
  assert.equal(finishOf(api).complete, true);
  assert.equal(finishOf(api).details.duplicates, 1);
});

test('complete:false when a job had to be dropped (the listing may be half-understood)', async () => {
  const { api } = await run(sourceOf('lever', { company: 'x' }), () => ({ body: [leverJob(1), leverJob(2, { applyUrl: 'http://insecure.example.test/a', hostedUrl: undefined })] }));
  assert.equal(sent(api).length, 1);
  const fin = finishOf(api);
  assert.equal(fin.complete, false);
  assert.equal(fin.status, 'ok');
  assert.equal(fin.details.dropped, 1);
});

test('complete:false when the database rejected anything in a batch', async () => {
  const api = fakeApi({ batch: (jobs) => ({ new: jobs.length - 1, updated: 0, duplicates: 0, skipped: 0, errors: ['job 2: invalid'] }) });
  const { res } = await run(sourceOf('lever', { company: 'x' }), () => ({ body: [leverJob(1), leverJob(2)] }), { api });
  assert.equal(finishOf(api).complete, false);
  assert.equal(res.stats.db_errors, 1);
});

test('complete:false and status partial when a cap stopped the run', async () => {
  const { api } = await run(sourceOf('lever', { company: 'x', max_jobs: 1 }), () => ({ body: [leverJob(1), leverJob(2)] }));
  const fin = finishOf(api);
  assert.equal(sent(api).length, 1);
  assert.equal(fin.complete, false);
  assert.equal(fin.status, 'partial');
});

test('an empty listing is ok but never complete (an API glitch must not close every job)', async () => {
  const { api } = await run(sourceOf('lever', { company: 'x' }), () => ({ body: [] }));
  assert.deepEqual(api.calls.map((c) => c[0]), ['start', 'finish']);
  assert.equal(finishOf(api).status, 'ok');
  assert.equal(finishOf(api).complete, false);
});

test('total failure: finish status failed with a short error, no URL, no stack, nothing sent', async () => {
  const { api, res } = await run(sourceOf('greenhouse', { board_token: 'acme' }), () => ({ status: 500 }), { httpOptions: { retries: 0 } });
  const fin = finishOf(api);
  assert.equal(fin.status, 'failed');
  assert.equal(fin.complete, false);
  assert.match(fin.error, /HTTP 500/);
  assert.ok(!/https?:|\n\s+at /.test(fin.error));
  assert.equal(api.calls.filter((c) => c[0] === 'batch').length, 0);
  assert.equal(res.status, 'failed');
});

test('rate limited by the source: partial (never "failed", so it cannot auto-disable the source)', async () => {
  const page = (skip) => (skip === 0 ? Array.from({ length: 100 }, (_, i) => leverJob(i)) : null);
  const { api } = await run(sourceOf('lever', { company: 'x' }), ({ path }) => {
    const rows = page(Number(/skip=(\d+)/.exec(path)[1]));
    return rows ? { body: rows } : { status: 429, headers: { 'retry-after': '1' } };
  });
  const fin = finishOf(api);
  assert.equal(fin.status, 'partial');
  assert.equal(fin.complete, false);
  assert.equal(sent(api).length, 100, 'what was fetched before the limit is kept');
  const first = await run(sourceOf('lever', { company: 'x' }), () => ({ status: 429, headers: { 'retry-after': '1' } }));
  assert.equal(finishOf(first.api).status, 'partial', 'even when nothing was fetched');
});

test('a batch that cannot be delivered: finish is still sent, complete:false, no secrets in the error', async () => {
  const api = fakeApi({ batch: () => { throw new Error(`ingest answered HTTP 500 at ${URL_SECRET}?k=1 with ${TOKEN}`); } });
  const { res } = await run(sourceOf('lever', { company: 'x' }), () => ({ body: [leverJob(1)] }), { api, secrets: [TOKEN, URL_SECRET] });
  const fin = finishOf(api);
  assert.equal(fin.complete, false);
  assert.equal(fin.status, 'failed');
  assert.ok(!fin.error.includes(TOKEN) && !fin.error.includes('secretproject') && !fin.error.includes('?k=1'), fin.error);
  assert.equal(res.status, 'failed');
});

test('a robots.txt refusal is recorded as a failed run with a clear message and nothing is fetched', async () => {
  const { api, server } = await run(sourceOf('rss', { url: 'https://feed.example.test/jobs.xml' }), ({ path }) => (path === '/robots.txt' ? { body: 'User-agent: *\nDisallow: /' } : { body: '<rss/>', headers: { 'content-type': 'text/xml' } }));
  assert.equal(finishOf(api).status, 'failed');
  assert.equal(finishOf(api).error, 'disallowed by robots.txt');
  assert.ok(!server.requests.some((r) => r.path === '/jobs.xml'));
});

test('unknown kind and the jsonld stub fail with a clear message', async () => {
  const unknown = await run(sourceOf('mystery', {}), () => undefined);
  assert.match(finishOf(unknown.api).error, /unsupported source kind/);
  const stub = await run(sourceOf('jsonld', {}), () => undefined);
  assert.match(finishOf(stub.api).error, /not implemented yet/);
  assert.equal(finishOf(stub.api).status, 'failed');
});

test('start failing means no fetch and no finish', async () => {
  const api = fakeApi({ start: new Error('ingest answered HTTP 403: invalid token') });
  const { res, server } = await run(sourceOf('lever', { company: 'x' }), () => ({ body: [] }), { api });
  assert.equal(res.status, 'not_started');
  assert.equal(server.requests.length, 0);
  assert.deepEqual(api.calls.map((c) => c[0]), ['start']);
});

test('dry run: fetches and normalises, prints counts, sends nothing (not even start/finish)', async () => {
  const { api, res, lines } = await run(sourceOf('lever', { company: 'x' }), () => ({ body: [leverJob(1), leverJob(2)] }), { dryRun: true });
  assert.equal(api.calls.length, 0);
  assert.equal(res.stats.fetched, 2);
  assert.equal(res.stats.sent, 2, 'counted as "would send"');
  assert.match(lines.join('\n'), /dry run/);
  assert.equal(res.complete, false);
});

test('main(): sources run one after another and a broken one never stops the others; exit 0', async () => {
  const sources = [
    sourceOf('greenhouse', { board_token: 'broken' }, { id: '00000000-0000-4000-8000-0000000000a1', name: 'Broken GH' }),
    sourceOf('lever', { company: 'good' }, { id: '00000000-0000-4000-8000-0000000000a2', name: 'Good Lever' }),
    sourceOf('rss', { url: 'https://feed.example.test/f.xml' }, { id: '00000000-0000-4000-8000-0000000000a3', name: 'Blocked Feed' }),
    sourceOf('lever', { company: 'also-good' }, { id: '00000000-0000-4000-8000-0000000000a4', name: 'Second Lever' }),
  ];
  const api = fakeApi();
  api.due = async () => sources;
  const server = await startFakeServer(({ host, path }) => {
    if (host === 'boards-api.greenhouse.io') return { status: 500 };
    if (path === '/robots.txt') return { body: 'User-agent: *\nDisallow: /' };
    if (host === 'api.lever.co') return { body: [leverJob(1)] };
    return undefined;
  });
  try {
    const { lines, log } = logLines();
    const code = await main([], { INGEST_URL: URL_SECRET, INGEST_TOKEN: TOKEN }, { createApi: () => api, createClient: () => httpFor(server, { retries: 0 }).http, log });
    assert.equal(code, 0);
    const finishes = api.calls.filter((c) => c[0] === 'finish').map((c) => c[2].status);
    assert.deepEqual(finishes, ['failed', 'ok', 'failed', 'ok']);
    assert.equal(api.calls.filter((c) => c[0] === 'start').length, 4);
    assert.match(lines.join('\n'), /done: 4 run\(s\), 2 failed/);
  } finally {
    await server.close();
  }
});

test('main(): source_name runs only that source; DRY_RUN env sends nothing', async () => {
  const sources = [sourceOf('lever', { company: 'a' }, { name: 'A' }), sourceOf('lever', { company: 'b' }, { name: 'B' })];
  const api = fakeApi();
  api.due = async () => sources;
  const server = await startFakeServer(() => ({ body: [leverJob(1)] }));
  try {
    const one = await main([], { INGEST_URL: URL_SECRET, INGEST_TOKEN: TOKEN, SOURCE_NAME: 'B' }, { createApi: () => api, createClient: () => httpFor(server).http, log: logLines().log });
    assert.equal(one, 0);
    assert.equal(server.requests.length, 1);
    assert.ok(server.requests[0].path.includes('/v0/postings/b'));
    api.calls.length = 0;
    await main(['--dry-run'], { INGEST_URL: URL_SECRET, INGEST_TOKEN: TOKEN }, { createApi: () => api, createClient: () => httpFor(server).http, log: logLines().log });
    assert.equal(api.calls.length, 0);
    await main([], { INGEST_URL: URL_SECRET, INGEST_TOKEN: TOKEN, DRY_RUN: 'true' }, { createApi: () => api, createClient: () => httpFor(server).http, log: logLines().log });
    assert.equal(api.calls.length, 0);
    await main([], { INGEST_URL: URL_SECRET, INGEST_TOKEN: TOKEN, DRY_RUN: 'false', SOURCE_NAME: '' }, { createApi: () => api, createClient: () => httpFor(server).http, log: logLines().log });
    assert.ok(api.calls.length > 0, 'DRY_RUN=false is a real run');
  } finally {
    await server.close();
  }
});

test('main(): setup problems exit 1 (missing secrets, the due call failing), with no secret in the output', async () => {
  const { lines, log } = logLines();
  assert.equal(await main([], {}, { log }), 1);
  const api = fakeApi();
  api.due = async () => { throw new Error(`ingest answered HTTP 403 for ${URL_SECRET} token ${TOKEN}`); };
  assert.equal(await main([], { INGEST_URL: URL_SECRET, INGEST_TOKEN: TOKEN }, { createApi: () => api, log }), 1);
  const out = lines.join('\n');
  assert.ok(!out.includes(TOKEN) && !out.includes('secretproject'), out);
});

test('logs and finish payloads never contain the token, the ingest URL or a vendor key', async () => {
  const KEY = 'usajobs-key-for-tests-0001';
  const api = fakeApi();
  api.due = async () => [sourceOf('usajobs', {}, { name: 'Federal' }), sourceOf('lever', { company: 'x' }, { name: 'L' })];
  const server = await startFakeServer(({ host }) => (host === 'data.usajobs.gov' ? { status: 500, body: `oops ${KEY}` } : { body: [leverJob(1)] }));
  try {
    const { lines, log } = logLines();
    await main([], { INGEST_URL: URL_SECRET, INGEST_TOKEN: TOKEN, USAJOBS_API_KEY: KEY, USAJOBS_EMAIL: 'ops@example.test' }, { createApi: () => api, createClient: () => httpFor(server, { retries: 0 }).http, log });
    const everything = lines.join('\n') + JSON.stringify(api.calls);
    for (const secret of [TOKEN, URL_SECRET, 'secretproject', KEY, 'ops@example.test']) assert.ok(!everything.includes(secret), `leaked ${secret}`);
  } finally {
    await server.close();
  }
});
