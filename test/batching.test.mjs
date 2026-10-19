import test from 'node:test';
import assert from 'node:assert/strict';
import { JobBatcher, jobBytes, MAX_BATCH_BYTES } from '../src/batching.mjs';

const job = (i, pad = 0) => ({ external_id: `id-${i}`, title: 'T', company: 'C', apply_url: 'https://x.test/', description: 'x'.repeat(pad) });
function run(jobs, opts) {
  const b = new JobBatcher(opts);
  const batches = [];
  let oversize = 0;
  for (const j of jobs) {
    const r = b.add(j);
    if (r.oversize) oversize += 1;
    batches.push(...r.ready);
  }
  batches.push(...b.flush());
  return { batches, oversize };
}

test('splits by count: 200 per batch', () => {
  const { batches } = run(Array.from({ length: 450 }, (_, i) => job(i)));
  assert.deepEqual(batches.map((b) => b.length), [200, 200, 50]);
});

test('exactly 200 jobs is one batch, 0 jobs is none', () => {
  assert.equal(run(Array.from({ length: 200 }, (_, i) => job(i))).batches.length, 1);
  assert.equal(run([]).batches.length, 0);
});

test('splits by bytes: no batch body exceeds the limit even with few, large jobs', () => {
  const jobs = Array.from({ length: 10 }, (_, i) => job(i, 300_000)); // 10 x ~300 KB
  const { batches } = run(jobs);
  assert.ok(batches.length >= 4, `expected a split, got ${batches.length}`);
  for (const b of batches) {
    const body = JSON.stringify({ action: 'batch', source_id: '00000000-0000-4000-8000-000000000001', run_id: '00000000-0000-4000-8000-000000000002', jobs: b });
    assert.ok(Buffer.byteLength(body) <= MAX_BATCH_BYTES, `${Buffer.byteLength(body)} bytes`);
    assert.ok(b.length <= 2, 'at most two 300 KB jobs fit under 900 KB');
  }
  assert.equal(batches.flat().length, 10, 'no job lost');
});

test('byte size counts UTF-8 bytes, not characters', () => {
  const ascii = { description: 'a'.repeat(1000) };
  const emoji = { description: '😀'.repeat(1000) };
  assert.ok(jobBytes(emoji) > jobBytes(ascii) * 3);
});

test('one job that can never fit is reported, not sent, and does not break the others', () => {
  const { batches, oversize } = run([job(1), job(2, 950_000), job(3)]);
  assert.equal(oversize, 1);
  assert.deepEqual(batches.flat().map((j) => j.external_id), ['id-1', 'id-3']);
});

test('order is preserved across batches', () => {
  const { batches } = run(Array.from({ length: 5 }, (_, i) => job(i)), { maxCount: 2 });
  assert.deepEqual(batches.flat().map((j) => j.external_id), ['id-0', 'id-1', 'id-2', 'id-3', 'id-4']);
});
