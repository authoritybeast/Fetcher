// Pure helpers that turn messy source data into the values the ingest endpoint accepts.
import { decodeEntities } from './util.mjs';

/** @type {Record<string,string>} lower-case state name -> 2-letter code (50 states + DC) */
export const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
export const STATE_CODES = new Set(Object.values(STATE_NAMES));

/**
 * 2-letter US state code for a code ("tx", "TX") or a full name ("Texas", "washington dc").
 * "Georgia" alone is ambiguous (the country), so it is only accepted when `allowGeorgia` is set (the caller saw US evidence).
 * @param {unknown} value
 * @param {{allowGeorgia?: boolean}} [opts]
 * @returns {string|undefined}
 */
export function stateCode(value, { allowGeorgia = false } = {}) {
  const t = String(value ?? '').trim().replace(/\.$/, '');
  if (!t) return undefined;
  if (/^[A-Za-z]{2}$/.test(t)) {
    const up = t.toUpperCase();
    return STATE_CODES.has(up) ? up : undefined;
  }
  const key = t.toLowerCase().replace(/\s+/g, ' ');
  if (key === 'washington dc' || key === 'washington d.c' || key === 'd.c' || key === 'dc') return 'DC';
  if (key === 'georgia' && !allowGeorgia) return undefined;
  return STATE_NAMES[key];
}

const COUNTRY_NAMES = {
  US: ['united states', 'united states of america', 'usa', 'u.s.a', 'u.s', 'us', 'america'],
  CA: ['canada'], GB: ['united kingdom', 'uk', 'u.k', 'great britain', 'england', 'scotland', 'wales', 'northern ireland'],
  DE: ['germany', 'deutschland'], FR: ['france'], ES: ['spain', 'españa'], IT: ['italy', 'italia'], NL: ['netherlands', 'the netherlands', 'holland'],
  IE: ['ireland'], AU: ['australia'], NZ: ['new zealand'], IN: ['india'], MX: ['mexico', 'méxico'], BR: ['brazil', 'brasil'],
  PL: ['poland'], PT: ['portugal'], SE: ['sweden'], NO: ['norway'], DK: ['denmark'], FI: ['finland'], CH: ['switzerland'],
  AT: ['austria'], BE: ['belgium'], JP: ['japan'], SG: ['singapore'], ZA: ['south africa'], IL: ['israel'], AE: ['united arab emirates', 'uae'],
  UA: ['ukraine'], RO: ['romania'], CZ: ['czechia', 'czech republic'], PH: ['philippines'], AR: ['argentina'], CO: ['colombia'], CL: ['chile'],
};
const COUNTRY_LOOKUP = new Map(Object.entries(COUNTRY_NAMES).flatMap(([code, names]) => names.map((n) => [n, code])));
export const US_WORDS = /(?:\b(?:united states(?: of america)?|usa|u\.s\.a?\.?)\b|(?:^|[^A-Za-z])US(?:$|[^A-Za-z]))/;

/**
 * ISO 3166 alpha-2 code from a code or a country name. Unknown names give undefined (never a guess).
 * @param {unknown} value
 */
export function normalizeCountry(value) {
  const t = String(value ?? '').trim().replace(/\.$/, '');
  if (!t) return undefined;
  if (/^[A-Za-z]{2}$/.test(t)) {
    const up = t.toUpperCase();
    return up === 'UK' ? 'GB' : up;
  }
  return COUNTRY_LOOKUP.get(t.toLowerCase().replace(/\s+/g, ' '));
}

/**
 * Pull city / state / ZIP / country / remote out of free location text. Conservative: only what the text shows.
 * "City, ST" is read as a US place (the code must be a US state); "Remote - US", "United States", "USA", "Anywhere in the US"
 * mean remote + US. Explicit country fields from the source always beat this guess, so call it only as a fallback.
 * @param {unknown} text
 * @returns {{city?:string, region?:string, postal?:string, country?:string, workMode?:'remote'|'hybrid'}}
 */
export function parseLocation(text) {
  const raw = decodeEntities(String(text ?? '')).replace(/\s+/g, ' ').trim();
  if (!raw) return {};
  /** @type {{city?:string, region?:string, postal?:string, country?:string, workMode?:'remote'|'hybrid'}} */
  const out = {};
  if (/\bhybrid\b/i.test(raw)) out.workMode = 'hybrid';
  else if (/\b(remote|work from home|wfh|anywhere)\b/i.test(raw)) out.workMode = 'remote';
  const hasUs = US_WORDS.test(raw);
  if (hasUs) out.country = 'US';

  const segments = raw
    .replace(/\((?:remote|hybrid|on-?site)[^)]*\)/gi, ' ')
    .replace(/\b(remote|hybrid|work from home|wfh|anywhere|nationwide|in the|within the|only|based)\b/gi, ' ')
    .replace(/[–—-]+/g, ' ')
    .split(/[,/|;()]/)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // 1. country words at the end
  while (segments.length) {
    const last = segments[segments.length - 1];
    const code = COUNTRY_LOOKUP.get(last.toLowerCase().replace(/\.$/, ''));
    const leadingIn = /^in (the )?(us|usa|united states)$/i.test(last);
    if (!code && !leadingIn) break;
    segments.pop();
    out.country = leadingIn ? 'US' : code;
    if (out.country !== 'US') {
      const city = segments[segments.length - 1];
      if (city && /^[A-Za-z .'’-]{2,60}$/.test(city)) out.city = city;
      return out;
    }
  }
  if (!segments.length) {
    // only country words / "remote" were left: "United States", "Remote - US"
    if (out.country === 'US' && !out.workMode) out.workMode = 'remote';
    return out;
  }

  // 2. "ST", "ST 12345" or a state name at the end
  const last = segments[segments.length - 1];
  const code = /^([A-Z]{2})(?:\s+(\d{5})(?:-\d{4})?)?$/.exec(last);
  let region;
  let postal;
  if (code && STATE_CODES.has(code[1])) {
    if (segments.length >= 2 || out.country === 'US') {
      region = code[1];
      postal = code[2];
    }
  } else {
    const named = /^([A-Za-z .]+?)(?:\s+(\d{5})(?:-\d{4})?)?$/.exec(last);
    if (named) {
      region = stateCode(named[1], { allowGeorgia: out.country === 'US' });
      postal = named[2];
    }
  }
  if (!region) return out;
  out.region = region;
  out.country = 'US';
  if (postal) out.postal = postal;
  segments.pop();
  const city = segments[segments.length - 1];
  if (city && /^[A-Za-z .'’-]{2,60}$/.test(city) && !COUNTRY_LOOKUP.has(city.toLowerCase())) out.city = city;
  return out;
}

/**
 * @param {...unknown} values explicit work-mode strings first, free text after
 * @returns {'onsite'|'hybrid'|'remote'|undefined}
 */
export function detectWorkMode(...values) {
  for (const v of values) {
    if (typeof v === 'boolean') continue;
    const t = String(v ?? '').toLowerCase().trim();
    if (!t) continue;
    if (/^(on-?site|in-?office|in office|office)$/.test(t)) return 'onsite';
    if (/\bhybrid\b/.test(t)) return 'hybrid';
    if (/\b(remote|work from home|wfh|telework|telecommut\w*|anywhere)\b/.test(t)) return 'remote';
    if (/^on-?site\b/.test(t)) return 'onsite';
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {'full-time'|'part-time'|'contract'|'freelance'|'internship'|undefined}
 */
export function mapJobType(value) {
  const t = String(value ?? '').toLowerCase().replace(/[_\s]+/g, '-').trim();
  if (!t) return undefined;
  if (/intern/.test(t)) return 'internship';
  if (/free-?lanc/.test(t)) return 'freelance';
  if (/part-?time/.test(t)) return 'part-time';
  if (/full-?time|permanent|regular/.test(t)) return 'full-time';
  if (/contract|temp|seasonal/.test(t)) return 'contract';
  return undefined;
}

/**
 * https only, no credentials, tracking params (utm_*) removed, max 2000 chars. Anything else gives undefined.
 * @param {unknown} value
 * @param {string} [base] resolve relative URLs against this
 */
export function cleanUrl(value, base) {
  const s = String(value ?? '').trim();
  if (!s || /[\u0000-\u001f\s]/.test(s)) return undefined;
  let u;
  try {
    u = new URL(s, base);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return undefined;
  for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key)) u.searchParams.delete(key);
  const out = u.toString();
  return out.length <= 2000 ? out : undefined;
}

/**
 * Cut HTML to at most `max` characters without leaving a half tag or half entity at the end. The database sanitises anyway.
 * @param {unknown} html
 * @param {number} [max]
 */
export function capHtml(html, max = 50_000) {
  let s = String(html ?? '');
  if (s.length <= max) return s;
  s = s.slice(0, max);
  const lt = s.lastIndexOf('<');
  if (lt > s.lastIndexOf('>')) s = s.slice(0, lt);
  s = s.replace(/&[#a-z0-9]{0,8}$/i, '');
  return s;
}

/** Greenhouse (and some feeds) deliver HTML as escaped text ("&lt;p&gt;"). Decode it once when that is clearly the case. */
export function unescapeIfEscaped(html) {
  const s = String(html ?? '');
  if (!s.includes('<') && /&lt;\s*[a-z/]/i.test(s)) return decodeEntities(s);
  return s;
}

// ---- salary ---------------------------------------------------------------------------------------------------------------------------------
export const PERIODS = ['hour', 'day', 'week', 'month', 'year'];
const PER_YEAR = { hour: 2080, day: 260, week: 52, month: 12, year: 1 };
// A value outside these ranges is a data error (or the wrong unit), so the salary is left out.
const PLAUSIBLE = { hour: [1, 1000], day: [10, 10_000], week: [50, 50_000], month: [200, 200_000], year: [2000, 5_000_000] };

/** Convert an amount between pay periods (2080 h/year, 260 days, 52 weeks, 12 months). */
export function convertSalary(amount, from, to) {
  if (!Number.isFinite(amount) || !(from in PER_YEAR) || !(to in PER_YEAR)) return undefined;
  return Math.round(((amount * PER_YEAR[from]) / PER_YEAR[to]) * 100) / 100;
}

/** @param {unknown} v */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/[$€£,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  return Number(t);
}

/**
 * Validate a structured salary. All-or-nothing: if anything is doubtful the result is {} (no salary sent).
 * @param {{min?:unknown,max?:unknown,period?:unknown,currency?:unknown}} s
 * @returns {{salary_min?:number,salary_max?:number,salary_period?:string,salary_currency?:string}}
 */
export function cleanSalary(s) {
  const period = String(s?.period ?? '').toLowerCase();
  if (!PERIODS.includes(period)) return {};
  let min = toNumber(s.min);
  let max = toNumber(s.max);
  if (min === undefined && max === undefined) return {};
  if (min === undefined) min = max;
  if (max === undefined) max = min;
  if (min <= 0 || max <= 0 || min > max) return {};
  const [lo, hi] = PLAUSIBLE[period];
  if (min < lo || max > hi) return {};
  const cur = String(s.currency ?? 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return {};
  return { salary_min: min, salary_max: max, salary_period: period, salary_currency: cur };
}

const PERIOD_WORDS = { hour: 'hour', hr: 'hour', hourly: 'hour', year: 'year', yr: 'year', annum: 'year', annually: 'year', month: 'month', week: 'week', day: 'day' };

/**
 * Salary from free text, only for the unambiguous shape "$20 - $25 per hour" / "$20-$25/hr" / "$60,000 - $80,000 a year".
 * Anything else (single numbers, no currency sign, no period, several ranges) gives {}.
 * @param {unknown} text
 */
export function parseSalaryText(text) {
  const s = String(text ?? '');
  const re = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|—|to)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(?:per|\/|a|an|each)\s*(hour|hr|year|yr|annum|month|week|day)\b/gi;
  const matches = [...s.matchAll(re)];
  if (matches.length !== 1) return {};
  const m = matches[0];
  return cleanSalary({ min: m[1], max: m[2], period: PERIOD_WORDS[m[3].toLowerCase()], currency: 'USD' });
}

/** ISO date string, or undefined. Accepts Date, ISO/RFC 2822 strings and epoch seconds/milliseconds. Future dates are clamped to now. */
export function toIsoDate(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return undefined;
  let ms;
  if (typeof value === 'number') ms = value < 1e11 ? value * 1000 : value;
  else if (value instanceof Date) ms = value.getTime();
  else if (/^\d{9,13}$/.test(String(value).trim())) return toIsoDate(Number(value), now);
  else ms = Date.parse(String(value));
  if (!Number.isFinite(ms) || ms < Date.UTC(1990, 0, 1)) return undefined;
  return new Date(Math.min(ms, now)).toISOString();
}
