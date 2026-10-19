import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHost, createSafeLookup, isForbiddenHostname, isPrivateAddress, UnsafeUrlError } from '../src/ssrf.mjs';
import { createHttp, DeadlineError, HttpError, RateLimitError, userAgentFor } from '../src/http.mjs';
import { fastClock, httpFor, PUBLIC_LOOKUP, startFakeServer } from '../test-support/fake-server.mjs';

test('isPrivateAddress: private, loopback, link-local, metadata, reserved', () => {
  for (const ip of ['127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.5']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('isPrivateAddress: public addresses pass', () => {
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '172.15.255.255', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('forbidden hostnames', () => {
  for (const h of ['localhost', 'a.localhost', 'printer.local', 'db.internal', 'metadata', 'LOCALHOST.']) assert.equal(isForbiddenHostname(h), true, h);
  assert.equal(isForbiddenHostname('example.com'), false);
});

test('assertPublicHost: literals, resolution, mixed answers', async () => {
  await assert.rejects(assertPublicHost('127.0.0.1'), UnsafeUrlError);
  await assert.rejects(assertPublicHost('[::1]'), UnsafeUrlError);
  await assert.rejects(assertPublicHost('localhost', PUBLIC_LOOKUP), UnsafeUrlError);
  await assert.rejects(assertPublicHost('evil.test', async () => [{ address: '10.0.0.5', family: 4 }]), /non-public/);
  await assert.rejects(assertPublicHost('mixed.test', async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]), /non-public/, 'one private answer is enough to refuse');
  await assert.rejects(assertPublicHost('nx.test', async () => { throw new Error('ENOTFOUND'); }), /could not be resolved/);
  assert.equal((await assertPublicHost('ok.test', PUBLIC_LOOKUP))[0].address, '93.184.216.34');
});

test('safe lookup validates at connect time (DNS rebinding)', async () => {
  let answer = [{ address: '93.184.216.34', family: 4 }];
  const lookup = createSafeLookup(async () => answer);
  const first = await new Promise((resolve) => lookup('rebind.test', { all: true }, (err, addrs) => resolve({ err, addrs })));
  assert.equal(first.err, null);
  assert.equal(first.addrs[0].address, '93.184.216.34');
  answer = [{ address: '127.0.0.1', family: 4 }]; // the name now points inside
  const second = await new Promise((resolve) => lookup('rebind.test', {}, (err) => resolve({ err })));
  assert.ok(second.err instanceof UnsafeUrlError);
});

test('http client refuses unsafe URLs before any request is made', async () => {
  const server = await startFakeServer(() => ({ body: { ok: true } }));
  try {
    const { http } = httpFor(server);
    for (const url of ['http://api.example.test/x', 'https://user:pw@api.example.test/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data/', 'https://2130706433/', 'https://localhost/x', 'ftp://x.test/', 'not a url']) {
      await assert.rejects(http.get(url), UnsafeUrlError, url);
    }
    const privateHost = httpFor(server, { lookup: async () => [{ address: '10.0.0.7', family: 4 }] }).http;
    await assert.rejects(privateHost.get('https://looks-public.test/x'), /non-public/);
    assert.equal(server.requests.length, 0, 'nothing reached the network');
  } finally {
    await server.close();
  }
});

test('http client re-checks every redirect and limits them to 3', async () => {
  const server = await startFakeServer(({ path }) => {
    if (path === '/to-private') return { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } };
    if (path === '/to-http') return { status: 302, headers: { location: 'http://api.example.test/plain' } };
    if (path === '/ok') return { body: { ok: true } };
    const n = Number(/^\/hop(\d+)$/.exec(path)?.[1] ?? -1);
    if (n >= 0) return { status: 301, headers: { location: `https://api.example.test/hop${n + 1}` } };
    if (path === '/start3') return { status: 301, headers: { location: 'https://api.example.test/hop98' } };
    return undefined;
  });
  try {
    const { http } = httpFor(server);
    await assert.rejects(http.get('https://api.example.test/to-private'), UnsafeUrlError);
    await assert.rejects(http.get('https://api.example.test/to-http'), UnsafeUrlError);
    await assert.rejects(http.get('https://api.example.test/hop0'), /too many redirects/);
    const sameThree = await startFakeServer(({ path }) => {
      const m = /^\/r(\d)$/.exec(path);
      if (m && Number(m[1]) < 3) return { status: 302, headers: { location: `https://api.example.test/r${Number(m[1]) + 1}` } };
      return { body: { done: path } };
    });
    try {
      const ok = await httpFor(sameThree).http.getJson('https://api.example.test/r0');
      assert.equal(ok.json.done, '/r3', 'exactly 3 redirects are fine');
    } finally {
      await sameThree.close();
    }
  } finally {
    await server.close();
  }
});

test('custom headers (API keys) are not sent to another host after a redirect', async () => {
  const seen = [];
  const server = await startFakeServer(({ host, path, headers }) => {
    seen.push([host, headers['authorization-key'] ?? null]);
    if (host === 'api.example.test' && path === '/a') return { status: 302, headers: { location: 'https://other.example.test/b' } };
    return { body: { ok: true } };
  });
  try {
    await httpFor(server).http.getJson('https://api.example.test/a', { headers: { 'authorization-key': 'secret-key-value' } });
    assert.deepEqual(seen, [['api.example.test', 'secret-key-value'], ['other.example.test', null]]);
  } finally {
    await server.close();
  }
});

test('http client: content type, size cap, timeout', async () => {
  const server = await startFakeServer(({ path }) => {
    if (path === '/html-ok') return { headers: { 'content-type': 'text/html' }, body: '<p>hi</p>' };
    if (path === '/binary') return { headers: { 'content-type': 'application/octet-stream' }, body: 'x' };
    if (path === '/image') return { headers: { 'content-type': 'image/png' }, body: 'x' };
    if (path === '/big') return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(5000) }) };
    if (path === '/hang') return new Promise(() => {});
    if (path === '/notjson') return { headers: { 'content-type': 'application/json' }, body: 'oops <secret-token>' };
    return undefined;
  });
  try {
    const { http } = httpFor(server, { maxBytes: 1000, timeoutMs: 150, retries: 0 });
    assert.equal((await http.get('https://api.example.test/html-ok')).text, '<p>hi</p>');
    await assert.rejects(http.get('https://api.example.test/binary'), /content type/);
    await assert.rejects(http.get('https://api.example.test/image'), /content type/);
    await assert.rejects(http.get('https://api.example.test/big'), /too large/);
    await assert.rejects(http.get('https://api.example.test/hang'), /timed out/);
    await assert.rejects(http.getJson('https://api.example.test/notjson'), (e) => e instanceof HttpError && !/secret-token/.test(e.message));
  } finally {
    await server.close();
  }
});

test('http client: 5xx and network errors are retried twice with exponential backoff, then it gives up', async () => {
  let calls = 0;
  const server = await startFakeServer(({ path }) => {
    calls += 1;
    if (path === '/flaky') return calls <= 2 ? { status: 503 } : { body: { ok: 1 } };
    if (path === '/down') return { status: 500 };
    return undefined;
  });
  try {
    const a = httpFor(server);
    assert.deepEqual((await a.http.getJson('https://api.example.test/flaky')).json, { ok: 1 });
    assert.equal(calls, 3, '1 try + 2 retries');
    assert.deepEqual(a.clock.slept.filter((ms) => ms >= 1000), [1000, 2000], 'exponential: 1 s then 2 s (jitter is 0 in tests)');
    calls = 0;
    await assert.rejects(httpFor(server).http.get('https://api.example.test/down'), (e) => e instanceof HttpError && e.status === 500);
    assert.equal(calls, 3);
    calls = 0;
    const server404 = await startFakeServer(() => ({ status: 404, body: 'x' }));
    try {
      await assert.rejects(httpFor(server404).http.get('https://api.example.test/x'), (e) => e instanceof HttpError && e.status === 404);
      assert.equal(server404.requests.length, 1, '4xx is not retried');
    } finally {
      await server404.close();
    }
  } finally {
    await server.close();
  }
});

test('http client: 429 honours Retry-After, then gives up with RateLimitError', async () => {
  let calls = 0;
  const server = await startFakeServer(({ path }) => {
    calls += 1;
    if (path === '/once') return calls === 1 ? { status: 429, headers: { 'retry-after': '3' } } : { body: { ok: 1 } };
    if (path === '/always') return { status: 429, headers: { 'retry-after': '2' } };
    if (path === '/long') return { status: 429, headers: { 'retry-after': '600' } };
    return undefined;
  });
  try {
    const a = httpFor(server);
    assert.deepEqual((await a.http.getJson('https://api.example.test/once')).json, { ok: 1 });
    assert.ok(a.clock.slept.includes(3000), 'waited the Retry-After time');
    calls = 0;
    const b = httpFor(server);
    await assert.rejects(b.http.get('https://api.example.test/always'), RateLimitError);
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(httpFor(server).http.get('https://api.example.test/long'), RateLimitError);
    assert.equal(calls, 1, 'a Retry-After longer than a minute means give up at once');
  } finally {
    await server.close();
  }
});

test('http client: polite delay between requests and the run deadline', async () => {
  const server = await startFakeServer(() => ({ body: { ok: 1 } }));
  try {
    const clock = fastClock();
    const { http } = httpFor(server, { delayMs: 300, sleep: clock.sleep, now: clock.now });
    await http.get('https://api.example.test/1');
    await http.get('https://api.example.test/2');
    await http.get('https://api.example.test/3');
    assert.ok(clock.slept.length >= 2 && clock.slept.every((ms) => ms >= 1 && ms <= 300), `delays: ${clock.slept}`);
    assert.equal(createHttp().config.delayMs, 300, 'default gap is 300 ms');
    let over = false;
    const limited = httpFor(server, { expired: () => over }).http;
    await limited.get('https://api.example.test/ok');
    over = true;
    await assert.rejects(limited.get('https://api.example.test/late'), DeadlineError);
  } finally {
    await server.close();
  }
});

test('the user agent names the fetcher', async () => {
  const server = await startFakeServer(() => ({ body: { ok: 1 } }));
  try {
    await httpFor(server).http.get('https://api.example.test/ua');
    assert.match(server.requests[0].headers['user-agent'], /^InstashoutFetcher\/1\.0 \(\+https:\/\/github\.com\/.+\/fetcher\)$/);
    assert.equal(userAgentFor('acme/fetcher'), 'InstashoutFetcher/1.0 (+https://github.com/acme/fetcher)', 'taken from GITHUB_REPOSITORY in Actions');
    assert.match(userAgentFor('bad value; x'), /<owner>/, 'anything odd falls back to the default');
  } finally {
    await server.close();
  }
});

test('connect-time guard: https.request with the safe lookup never connects to a name that now resolves inside', async () => {
  const { createServer } = await import('node:net');
  const { default: https } = await import('node:https');
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const lookup = createSafeLookup(async () => [{ address: '127.0.0.1', family: 4 }]); // "rebinding": the public-looking name points at loopback
    const err = await new Promise((resolve) => {
      const req = https.request({ host: 'rebind.example.test', port: server.address().port, path: '/', lookup, agent: false }, () => resolve(null));
      req.on('error', resolve);
      req.end();
    });
    assert.ok(err, 'the request failed');
    assert.match(String(err.message), /refused: host resolves to a non-public address|non-public/);
    assert.equal(connections, 0, 'no TCP connection was opened');
  } finally {
    server.close();
  }
});
