// A local fake HTTP server + an http client wired to it, so no test ever touches the real network.
// Requests are rewritten from  https://api.example.test/path?q  to  http://127.0.0.1:PORT/api.example.test/path?q ,
// so a route can tell hosts apart and the test can assert the exact URL the connector built.
import { createServer } from 'node:http';
import { createHttp } from '../src/http.mjs';

/**
 * @param {(req:{method:string, host:string, path:string, headers:Record<string,any>}) => {status?:number, headers?:Record<string,string>, body?:string|Buffer|object}|undefined|Promise<any>} handler
 */
export async function startFakeServer(handler) {
  /** @type {{method:string, host:string, path:string, headers:Record<string,any>}[]} */
  const requests = [];
  const server = createServer(async (req, res) => {
    const m = /^\/([^/]+)(\/.*)?$/.exec(req.url || '/');
    const info = { method: req.method || 'GET', host: m?.[1] || '', path: m?.[2] || '/', headers: req.headers };
    requests.push(info);
    const out = (await handler(info)) || { status: 404, body: 'not found' };
    const body = typeof out.body === 'object' && !Buffer.isBuffer(out.body) ? JSON.stringify(out.body) : out.body ?? '';
    const isJson = typeof out.body === 'object' && !Buffer.isBuffer(out.body);
    res.writeHead(out.status ?? 200, { 'content-type': isJson ? 'application/json' : 'text/plain', ...(out.headers || {}) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return {
    requests,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

export const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

/** Delays that the client asked for instead of waiting for them. */
export function fastClock() {
  const slept = [];
  let t = 1_000_000;
  return { slept, sleep: async (ms) => { slept.push(ms); t += ms; }, now: () => t };
}

/**
 * @param {{port:number}} server
 * @param {Parameters<typeof createHttp>[0]} [options]
 */
export function httpFor(server, options = {}) {
  const clock = fastClock();
  const http = createHttp({
    lookup: PUBLIC_LOOKUP,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0,
    delayMs: 0,
    testing: { rewrite: (url) => { const u = new URL(url); return `http://127.0.0.1:${server.port}/${u.host}${u.pathname}${u.search}`; } },
    ...options,
  });
  return { http, clock };
}

/** Run a connector's generator to the end. @returns {Promise<{jobs:any[], result:any}>} */
export async function collect(gen) {
  const jobs = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { jobs, result: step.value };
    jobs.push(step.value);
  }
}

export const sourceOf = (kind, config, extra = {}) => ({ id: '00000000-0000-4000-8000-000000000001', name: 'Test Source', kind, config, tier: 'full', us_only: true, fetch_interval_minutes: 1440, requested: false, ...extra });
