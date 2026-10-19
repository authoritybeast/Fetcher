import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createIngest, IngestError } from '../src/ingest.mjs';

const TOKEN = 'tok_test_do_not_use_0123456789';

async function fakeIngest(handler = () => undefined) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      calls.push({ method: req.method, headers: req.headers, body: parsed });
      const out = handler(parsed, calls.length) || { status: 200, json: { ok: true, data: null } };
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/functions/v1/ingest`;
  return { calls, url, close: () => new Promise((r) => server.close(r)) };
}
const noSleep = async () => {};

test('requires https unless explicitly allowed for tests, and both settings', () => {
  assert.throws(() => createIngest({ url: 'http://x.test/ingest', token: TOKEN }), /https/);
  assert.throws(() => createIngest({ url: '', token: TOKEN }), IngestError);
  assert.throws(() => createIngest({ url: 'https://x.test/ingest', token: '' }), IngestError);
  assert.throws(() => createIngest({ url: 'not a url', token: TOKEN }), /valid URL/);
});

test('the four actions: exact bodies, token header, POST', async () => {
  const srv = await fakeIngest((b) => {
    if (b.action === 'due') return { status: 200, json: { ok: true, data: [{ id: 's1', name: 'A', kind: 'lever' }] } };
    if (b.action === 'start') return { status: 200, json: { ok: true, data: 'run-1' } };
    if (b.action === 'batch') return { status: 200, json: { ok: true, data: { new: 1, updated: 0, duplicates: 0, skipped: 0, errors: [] } } };
    return { status: 200, json: { ok: true, data: null } };
  });
  try {
    const api = createIngest({ url: srv.url, token: TOKEN, allowHttp: true, sleep: noSleep });
    assert.equal((await api.due()).length, 1);
    assert.equal(await api.start('s1', 'schedule'), 'run-1');
    assert.equal((await api.batch('s1', 'run-1', [{ external_id: 'x' }])).new, 1);
    await api.finish('run-1', { status: 'partial', complete: false, error: 'boom', details: { fetched: 3 } });
    const bodies = srv.calls.map((c) => c.body);
    assert.deepEqual(bodies[0], { action: 'due' });
    assert.deepEqual(bodies[1], { action: 'start', source_id: 's1', trigger: 'schedule' });
    assert.deepEqual(bodies[2], { action: 'batch', source_id: 's1', run_id: 'run-1', jobs: [{ external_id: 'x' }] });
    assert.deepEqual(bodies[3], { action: 'finish', run_id: 'run-1', status: 'partial', complete: false, error: 'boom', details: { fetched: 3 } });
    for (const c of srv.calls) {
      assert.equal(c.method, 'POST');
      assert.equal(c.headers['x-ingest-token'], TOKEN);
      assert.equal(c.headers['content-type'], 'application/json');
    }
  } finally {
    await srv.close();
  }
});

test('finish without an error sends no error field', async () => {
  const srv = await fakeIngest();
  try {
    await createIngest({ url: srv.url, token: TOKEN, allowHttp: true }).finish('r', { status: 'ok', complete: true });
    assert.deepEqual(srv.calls[0].body, { action: 'finish', run_id: 'r', status: 'ok', complete: true });
  } finally {
    await srv.close();
  }
});

test('retries 5xx twice, never retries 4xx, and errors never contain the token or URL', async () => {
  let n = 0;
  const flaky = await fakeIngest(() => (++n <= 2 ? { status: 500, json: { error: 'oops' } } : { status: 200, json: { ok: true, data: 'run-9' } }));
  const forbidden = await fakeIngest(() => ({ status: 403, json: { error: 'invalid token' } }));
  const down = await fakeIngest(() => ({ status: 500, json: { error: 'still down' } }));
  try {
    assert.equal(await createIngest({ url: flaky.url, token: TOKEN, allowHttp: true, sleep: noSleep }).start('s', 'manual'), 'run-9');
    assert.equal(flaky.calls.length, 3);
    await assert.rejects(createIngest({ url: forbidden.url, token: TOKEN, allowHttp: true, sleep: noSleep }).due(), (e) => e instanceof IngestError && e.status === 403 && /invalid token/.test(e.message));
    assert.equal(forbidden.calls.length, 1, '403 is not retried');
    await assert.rejects(createIngest({ url: down.url, token: TOKEN, allowHttp: true, sleep: noSleep }).due(), (e) => e.status === 500 && !e.message.includes(TOKEN) && !e.message.includes(down.url));
    assert.equal(down.calls.length, 3);
    const unreachable = createIngest({ url: 'http://127.0.0.1:1/x', token: TOKEN, allowHttp: true, sleep: noSleep, retries: 1 });
    await assert.rejects(unreachable.due(), (e) => e instanceof IngestError && !e.message.includes(TOKEN) && !e.message.includes('127.0.0.1'));
  } finally {
    await Promise.all([flaky.close(), forbidden.close(), down.close()]);
  }
});
