import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseRobots } from '../src/robots.mjs';
import { RobotsDisallowedError } from '../src/http.mjs';
import { httpFor, startFakeServer } from '../test-support/fake-server.mjs';

const check = (text, path) => isAllowed(parseRobots(text), 'InstashoutFetcher', path);

test('robots.txt: groups, wildcards, longest match, Allow wins ties', () => {
  assert.equal(check('User-agent: *\nDisallow: /private', '/private/jobs'), false);
  assert.equal(check('User-agent: *\nDisallow: /private', '/public'), true);
  assert.equal(check('User-agent: *\nDisallow:', '/anything'), true, 'empty Disallow allows all');
  assert.equal(check('User-agent: *\nDisallow: /', '/x'), false);
  assert.equal(check('User-agent: *\nDisallow: /a\nAllow: /a/b', '/a/b/c'), true, 'longest pattern wins');
  assert.equal(check('User-agent: *\nDisallow: /a/b\nAllow: /a/b', '/a/b'), true, 'tie: Allow wins');
  assert.equal(check('User-agent: *\nDisallow: /*.json$', '/feed.json'), false);
  assert.equal(check('User-agent: *\nDisallow: /*.json$', '/feed.json?x=1'), true, '$ anchors the end');
  assert.equal(check('User-agent: *\nDisallow: /search?*q=', '/search?a=1&q=2'), false);
});

test('robots.txt: our own group beats *, other bots are ignored', () => {
  const text = 'User-agent: *\nDisallow: /\n\nUser-agent: InstashoutFetcher\nAllow: /\n\nUser-agent: badbot\nDisallow: /';
  assert.equal(check(text, '/jobs'), true);
  assert.equal(check('User-agent: instashoutfetcher\nDisallow: /jobs', '/jobs/1'), false, 'case-insensitive');
  assert.equal(check('User-agent: otherbot\nDisallow: /', '/jobs'), true);
  assert.equal(check('User-agent: a\nUser-agent: InstashoutFetcher\nDisallow: /x # comment', '/x'), false, 'stacked agent lines share rules');
});

test('generic fetch: robots.txt disallow means the feed is never requested', async () => {
  const server = await startFakeServer(({ path }) => {
    if (path === '/robots.txt') return { body: 'User-agent: *\nDisallow: /jobs/' };
    return { body: '<rss/>', headers: { 'content-type': 'application/xml' } };
  });
  try {
    const { http } = httpFor(server);
    await assert.rejects(http.get('https://feed.example.test/jobs/feed.xml', { robots: true }), RobotsDisallowedError);
    assert.deepEqual(server.requests.map((r) => r.path), ['/robots.txt'], 'only robots.txt was fetched');
    assert.equal((await http.get('https://feed.example.test/other/feed.xml', { robots: true })).text, '<rss/>');
    assert.equal(server.requests.filter((r) => r.path === '/robots.txt').length, 1, 'robots.txt is cached per host');
  } finally {
    await server.close();
  }
});

test('generic fetch: missing robots.txt (404) allows, a broken one (500) does not', async () => {
  const missing = await startFakeServer(({ path }) => (path === '/robots.txt' ? { status: 404 } : { body: 'ok', headers: { 'content-type': 'text/xml' } }));
  const broken = await startFakeServer(({ path }) => (path === '/robots.txt' ? { status: 500 } : { body: 'ok', headers: { 'content-type': 'text/xml' } }));
  try {
    assert.equal((await httpFor(missing).http.get('https://feed.example.test/f.xml', { robots: true })).text, 'ok');
    await assert.rejects(httpFor(broken).http.get('https://feed.example.test/f.xml', { robots: true }), RobotsDisallowedError);
    assert.ok(!broken.requests.some((r) => r.path === '/f.xml'));
  } finally {
    await missing.close();
    await broken.close();
  }
});

test('official vendor APIs are fetched without a robots.txt check', async () => {
  const server = await startFakeServer(() => ({ body: { ok: 1 } }));
  try {
    await httpFor(server).http.getJson('https://api.example.test/v1');
    assert.ok(!server.requests.some((r) => r.path === '/robots.txt'));
  } finally {
    await server.close();
  }
});
