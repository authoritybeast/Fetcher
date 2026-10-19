// The only way connectors touch the network. Untrusted URLs in, bounded text out.
//   https only, no credentials, public addresses only (checked again at connect time and after every redirect), max 3 redirects,
//   20 s timeout, 10 MB cap, JSON/XML/text content types only, polite delay between requests, retries with backoff,
//   Retry-After / 429 honoured, robots.txt for generic feeds.
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import { assertPublicHost, createSafeLookup, defaultLookup, UnsafeUrlError } from './ssrf.mjs';
import { isAllowed, parseRobots } from './robots.mjs';
import { sleep as realSleep } from './util.mjs';

export const PRODUCT = 'InstashoutFetcher';
export const DEFAULT_USER_AGENT = `${PRODUCT}/1.0 (+https://github.com/<owner>/fetcher)`;

/** User agent that points at this repository: GITHUB_REPOSITORY ("owner/fetcher") is set automatically in GitHub Actions. */
export const userAgentFor = (repo) => (/^[\w.-]+\/[\w.-]+$/.test(String(repo || '')) ? `${PRODUCT}/1.0 (+https://github.com/${repo})` : DEFAULT_USER_AGENT);

export class HttpError extends Error {
  /** @param {string} message @param {{status?:number}} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = info.status;
  }
}
export class RateLimitError extends HttpError {
  constructor(message = 'rate limited by the source') {
    super(message, { status: 429 });
    this.name = 'RateLimitError';
  }
}
export class RobotsDisallowedError extends Error {
  constructor() {
    super('disallowed by robots.txt');
    this.name = 'RobotsDisallowedError';
  }
}
export class DeadlineError extends Error {
  constructor() {
    super('run time budget used up');
    this.name = 'DeadlineError';
  }
}
export { UnsafeUrlError };

const ALLOWED_TYPE = /^(application\/(json|xml|[a-z0-9.+-]*\+json|[a-z0-9.+-]*\+xml)|text\/[a-z0-9.+-]+)\s*(;|$)/i;
const MAX_RETRY_AFTER_MS = 60_000;

/** @param {string|null|undefined} v seconds or an HTTP date */
export function parseRetryAfter(v, now = Date.now()) {
  if (!v) return undefined;
  const t = String(v).trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * @typedef {object} HttpOptions
 * @property {string} [userAgent]
 * @property {number} [delayMs] minimum gap between requests (default 300)
 * @property {number} [timeoutMs]
 * @property {number} [maxBytes]
 * @property {number} [maxRedirects]
 * @property {number} [retries]
 * @property {(ms:number)=>Promise<void>} [sleep]
 * @property {(host:string)=>Promise<{address:string,family:number}[]>} [lookup]
 * @property {()=>number} [now]
 * @property {()=>number} [random]
 * @property {()=>boolean} [expired] true when the run's time budget is gone
 * @property {{rewrite:(url:string)=>string}} [testing] TESTS ONLY: send the request to a local fake server (plain http allowed)
 */

/** @param {HttpOptions} [options] */
export function createHttp(options = {}) {
  const cfg = {
    userAgent: DEFAULT_USER_AGENT, delayMs: 300, timeoutMs: 20_000, maxBytes: 10 * 1024 * 1024, maxRedirects: 3, retries: 2,
    sleep: realSleep, lookup: defaultLookup, now: Date.now, random: Math.random, expired: () => false, ...options,
  };
  const safeLookup = createSafeLookup(cfg.lookup);
  let lastAt = 0;
  /** @type {Map<string, Promise<ReturnType<typeof parseRobots>|'deny'>>} */
  const robotsCache = new Map();

  async function pace() {
    const wait = lastAt + cfg.delayMs - cfg.now();
    if (wait > 0) await cfg.sleep(wait);
    lastAt = cfg.now();
  }

  /** @param {string|URL} input */
  async function validate(input) {
    let u;
    try {
      u = new URL(String(input));
    } catch {
      throw new UnsafeUrlError('not a valid URL');
    }
    if (u.protocol !== 'https:') throw new UnsafeUrlError('only https URLs are allowed');
    if (u.username || u.password) throw new UnsafeUrlError('credentials in URLs are not allowed');
    await assertPublicHost(u.hostname, cfg.lookup);
    return u;
  }

  /** One request, no retries or redirects. @returns {Promise<{status:number, headers:Record<string,string|string[]|undefined>, body:Buffer}>} */
  function once(url, headers, accept) {
    return new Promise((resolve, reject) => {
      const target = cfg.testing ? new URL(cfg.testing.rewrite(url.toString())) : url;
      const lib = target.protocol === 'http:' ? http : https;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        reject(err);
      };
      const req = lib.request(
        target,
        { method: 'GET', headers: { 'user-agent': cfg.userAgent, accept, 'accept-encoding': 'gzip, deflate', ...headers }, lookup: cfg.testing ? undefined : safeLookup, agent: false },
        (res) => {
          const status = res.statusCode || 0;
          const type = String(res.headers['content-type'] || '');
          if (status >= 300 && status < 400) {
            res.resume();
            settled = true;
            clearTimeout(timer);
            return resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
          }
          if (status >= 200 && status < 300 && !ALLOWED_TYPE.test(type)) {
            res.resume();
            return fail(new HttpError('unexpected content type'));
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > cfg.maxBytes && !res.headers['content-encoding']) {
            res.resume();
            return fail(new HttpError('response too large'));
          }
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          const source = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
          source.on('error', fail);
          const chunks = [];
          let size = 0;
          source.on('data', (c) => {
            size += c.length;
            if (size > cfg.maxBytes) return fail(new HttpError('response too large'));
            chunks.push(c);
          });
          source.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
          });
        },
      );
      const timer = setTimeout(() => fail(new Error('request timed out')), cfg.timeoutMs);
      req.on('error', fail);
      req.end();
    });
  }

  const retriable = (e) => !(e instanceof UnsafeUrlError) && !(e instanceof HttpError) && !(e instanceof RobotsDisallowedError);
  const backoff = (attempt) => cfg.sleep(1000 * 2 ** (attempt - 1) + Math.floor(cfg.random() * 250));

  /**
   * GET a URL and return the body as text.
   * @param {string} url
   * @param {{headers?:Record<string,string>, accept?:string, robots?:boolean}} [opts] headers are only sent to the original host
   * @returns {Promise<{status:number, text:string, headers:Record<string,string|string[]|undefined>, url:string}>}
   */
  async function get(url, opts = {}) {
    if (cfg.expired()) throw new DeadlineError();
    let current = await validate(url);
    const origin = current.origin;
    if (opts.robots) await checkRobots(current);
    let redirects = 0;
    let attempt = 0;
    for (;;) {
      if (cfg.expired()) throw new DeadlineError();
      await pace();
      const headers = current.origin === origin ? opts.headers || {} : {};
      let res;
      try {
        res = await once(current, headers, opts.accept || 'application/json');
      } catch (e) {
        if (retriable(e) && attempt < cfg.retries) {
          attempt += 1;
          await backoff(attempt);
          continue;
        }
        throw e instanceof Error ? e : new Error(String(e));
      }
      if (res.status >= 300 && res.status < 400 && !res.headers.location) throw new HttpError('redirect without a location');
      if (res.status >= 300 && res.status < 400) {
        redirects += 1;
        if (redirects > cfg.maxRedirects) throw new HttpError('too many redirects');
        current = await validate(new URL(String(res.headers.location), current));
        continue;
      }
      if (res.status === 429 || (res.status === 503 && res.headers['retry-after'])) {
        const wait = parseRetryAfter(String(res.headers['retry-after'] || ''), cfg.now());
        if (attempt >= cfg.retries || (wait !== undefined && wait > MAX_RETRY_AFTER_MS)) throw new RateLimitError();
        attempt += 1;
        await cfg.sleep(Math.min(wait ?? 2000 * 2 ** attempt, MAX_RETRY_AFTER_MS));
        continue;
      }
      if (res.status >= 500) {
        if (attempt < cfg.retries) {
          attempt += 1;
          await backoff(attempt);
          continue;
        }
        throw new HttpError(`source answered HTTP ${res.status}`, { status: res.status });
      }
      if (res.status >= 400) throw new HttpError(`source answered HTTP ${res.status}`, { status: res.status });
      return { status: res.status, text: new TextDecoder('utf-8').decode(res.body), headers: res.headers, url: current.toString() };
    }
  }

  /** Same as get() but parses JSON. The error never contains the body. */
  async function getJson(url, opts = {}) {
    const res = await get(url, { accept: 'application/json', ...opts });
    try {
      return { ...res, json: JSON.parse(res.text) };
    } catch {
      throw new HttpError('source did not return valid JSON');
    }
  }

  // ---- robots.txt
  async function loadRobots(u) {
    try {
      const res = await get(`${u.origin}/robots.txt`, { accept: 'text/plain' });
      return parseRobots(res.text);
    } catch (e) {
      if (e instanceof HttpError && e.status && e.status >= 400 && e.status < 500) return []; // no robots.txt: everything allowed (RFC 9309)
      return 'deny'; // unreachable or server error: do not crawl (RFC 9309)
    }
  }
  /** @param {URL} u */
  async function checkRobots(u) {
    if (!robotsCache.has(u.origin)) robotsCache.set(u.origin, loadRobots(u));
    const groups = await robotsCache.get(u.origin);
    if (groups === 'deny' || !isAllowed(groups, PRODUCT, u.pathname + u.search)) throw new RobotsDisallowedError();
  }

  return { get, getJson, config: cfg };
}
