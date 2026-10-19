import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, escapeHtml, getPath, plainText, safeMessage } from '../src/util.mjs';
import { createLogger } from '../src/log.mjs';

test('getPath: dotted paths, arrays, own properties only', () => {
  const o = { a: { b: [{ c: 5 }] }, 'x': null };
  assert.equal(getPath(o, 'a.b.0.c'), 5);
  assert.equal(getPath(o, 'a.nope.c'), undefined);
  assert.equal(getPath(o, ''), o);
  assert.equal(getPath(o, 'x.y'), undefined);
  for (const p of ['__proto__', 'a.__proto__', 'constructor', 'a.constructor.name', 'toString', 'a.b.length.constructor']) assert.equal(getPath(o, p), undefined, p);
});

test('decodeEntities: one pass, numeric and named, junk stays', () => {
  assert.equal(decodeEntities('a &amp; b &lt;p&gt; &#39;x&#39; &#x41; &nbsp;|'), "a & b <p> 'x' A  |");
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(decodeEntities('&bogus; &#0; &#xD800;'), '&bogus;  ');
});

test('plainText strips tags and control characters', () => {
  assert.equal(plainText('<b>Hi</b>\u0000  there &amp; <i>you</i>'), 'Hi there & you');
  assert.equal(plainText('&lt;script&gt;x&lt;/script&gt;'), 'x');
});

test('escapeHtml', () => assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;'));

test('safeMessage: secrets and URL details removed, short, one line', () => {
  const m = safeMessage(new Error('failed https://api.example.test/v1/x?key=SECRETKEY123 and SECRETKEY123 more\nstack'), ['SECRETKEY123']);
  assert.equal(m, 'failed https://api.example.test/… and [redacted] more stack');
  assert.ok(safeMessage(new Error('x'.repeat(500))).length <= 200);
  assert.equal(safeMessage(undefined), 'unknown error');
  assert.equal(safeMessage('plain string'), 'plain string');
});

test('logger redacts secrets and reduces URLs', () => {
  const lines = [];
  const log = createLogger({ secrets: ['topsecret-token'], write: (l) => lines.push(l) });
  log.info('using topsecret-token against https://secret.example.test/functions/v1/ingest?x=1');
  log.fail('boom', new Error('bad https://a.test/p?token=zz'));
  assert.deepEqual(lines, ['INFO  using [redacted] against https://secret.example.test/…', 'ERROR boom: bad https://a.test/…']);
});
