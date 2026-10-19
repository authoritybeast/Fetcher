// SSRF guard. Source configs come from a database, so every URL is untrusted: the host must resolve to public addresses only.
import net from 'node:net';
import dns from 'node:dns';

/** @param {string} ip dotted IPv4 */
function v4ToInt(ip) {
  return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => ({ start: v4ToInt(base), size: 2 ** (32 - bits) }));

function isPrivateV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some((b) => n >= b.start && n < b.start + b.size);
}

/** @param {string} ip IPv6 text -> 16 bytes, or null */
function v6Bytes(ip) {
  let s = ip.split('%')[0].toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const o = tail[1].split('.').map(Number);
    if (o.some((x) => x > 255)) return null;
    s = s.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (parts.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = parts.length === 2 ? [...head, ...Array(missing).fill('0'), ...rest] : head;
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 255);
  }
  return bytes;
}

/**
 * True when the address is loopback, private, link-local, multicast, reserved, a cloud metadata address, or malformed.
 * IPv4-mapped / NAT64 / 6to4 IPv6 addresses are judged by the IPv4 address they carry.
 * @param {string} ip
 */
export function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind !== 6) return true;
  const b = v6Bytes(ip);
  if (!b) return true;
  const allZero = (from, to) => b.slice(from, to).every((x) => x === 0);
  const v4 = (o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  if (allZero(0, 16)) return true; // ::
  if (allZero(0, 15) && b[15] === 1) return true; // ::1
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(v4(12)); // ::ffff:a.b.c.d
  if (allZero(0, 12)) return true; // ::a.b.c.d (deprecated IPv4-compatible)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12)) return isPrivateV4(v4(12)); // 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(v4(2)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local (includes fd00:ec2::254, the AWS metadata address)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/** Hostnames that must never be fetched, whatever they resolve to. */
export function isForbiddenHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localdomain') || h === 'metadata';
}

/** Default resolver: every address of the host. */
export const defaultLookup = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve a hostname and make sure every address is public. Returns the addresses.
 * @param {string} hostname hostname or IP literal (IPv6 without brackets)
 * @param {(h:string)=>Promise<{address:string,family:number}[]>} [lookup]
 */
export async function assertPublicHost(hostname, lookup = defaultLookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isForbiddenHostname(host)) throw new UnsafeUrlError('host is not allowed');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError('address is not public');
    return [{ address: host, family: net.isIP(host) }];
  }
  let addrs;
  try {
    addrs = await lookup(host);
  } catch {
    throw new UnsafeUrlError('host could not be resolved');
  }
  if (!addrs.length) throw new UnsafeUrlError('host could not be resolved');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError('host resolves to a non-public address');
  return addrs;
}

export class UnsafeUrlError extends Error {
  constructor(message) {
    super(`refused: ${message}`);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * A `lookup` for https.request that validates at connect time (closes the DNS-rebinding gap between "check" and "connect").
 * @param {(h:string)=>Promise<{address:string,family:number}[]>} lookup
 */
export function createSafeLookup(lookup = defaultLookup) {
  return (hostname, options, cb) => {
    const done = typeof options === 'function' ? options : cb;
    const opts = typeof options === 'function' ? {} : options || {};
    assertPublicHost(hostname, lookup).then(
      (addrs) => {
        const pick = opts.family ? addrs.filter((a) => a.family === opts.family) : addrs;
        const list = pick.length ? pick : addrs;
        if (opts.all) done(null, list);
        else done(null, list[0].address, list[0].family);
      },
      (err) => done(err),
    );
  };
}
