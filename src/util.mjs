// Small shared helpers. Everything here is pure (except sleep).

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {unknown} v @returns {v is Record<string, any>} */
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const BAD_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Read a dotted path ("data.jobs.0.title") from parsed JSON. Only own properties are followed, so a path can never reach
 * the prototype chain. Returns undefined when anything on the way is missing.
 * @param {unknown} obj
 * @param {string} path
 */
export function getPath(obj, path) {
  if (typeof path !== 'string' || path === '') return obj;
  let cur = obj;
  for (const seg of path.split('.')) {
    if (BAD_SEGMENTS.has(seg)) return undefined;
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = /** @type {any} */ (cur)[seg];
  }
  return cur;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the basic HTML/XML entities (named + numeric). Single pass, so "&amp;lt;" becomes "&lt;" and no further. */
export function decodeEntities(str) {
  return String(str ?? '').replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Feed/JSON text that should be plain: decode entities, drop tags, collapse whitespace. */
export function plainText(str) {
  return decodeEntities(String(str ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape text for use inside HTML we build ourselves. */
export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Make an error message safe for logs and for the `finish` call: no secrets, no query strings, no stack, short.
 * @param {unknown} err
 * @param {string[]} [secrets]
 */
export function safeMessage(err, secrets = []) {
  let msg = err instanceof Error ? err.message : String(err ?? 'unknown error');
  for (const s of secrets) if (s && s.length >= 4) msg = msg.split(s).join('[redacted]');
  msg = msg
    .replace(/\[redacted\]\?\S*/g, '[redacted]') // a query string that followed a redacted URL
    .replace(/https?:\/\/([^\s/?#"')]+)[^\s"')]*/gi, (_m, host) => `https://${host}/…`)
    .replace(/\s+/g, ' ')
    .trim();
  return msg.length > 200 ? `${msg.slice(0, 197)}...` : msg || 'unknown error';
}
