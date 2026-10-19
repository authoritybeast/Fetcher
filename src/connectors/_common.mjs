// Shared pieces for the connectors.
//
// Connector interface:
//   export async function* fetchJobs({ source, env, http, log, expired }) { yield rawJob; ...; return { complete, truncated } }
//   - rawJob uses the ingest field names (see src/job.mjs); finalizeJob() validates it and drops what must not be sent.
//   - return `complete: true` ONLY when the whole listing was fetched with no error, cut-off or cap hit. Any doubt: false.
//   - `truncated: true` when a cap (pages / jobs / time) stopped the run early.
import { normalizeCountry, parseLocation, stateCode } from '../normalize.mjs';

export const DEFAULT_MAX_PAGES = 50;
export const DEFAULT_MAX_JOBS = 5000;
export const HARD_MAX_JOBS = 20_000;

export class ConfigError extends Error {
  constructor(message) {
    super(`config: ${message}`);
    this.name = 'ConfigError';
  }
}
export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/** @param {unknown} config */
export const configOf = (config) => (config && typeof config === 'object' && !Array.isArray(config) ? /** @type {Record<string, any>} */ (config) : {});

/**
 * max_pages may only LOWER the default of 50; max_jobs defaults to 5000 (1..20000).
 * @param {unknown} config
 */
export function limitsOf(config) {
  const c = configOf(config);
  const pages = Number.isInteger(c.max_pages) && c.max_pages >= 1 ? Math.min(c.max_pages, DEFAULT_MAX_PAGES) : DEFAULT_MAX_PAGES;
  const jobs = Number.isInteger(c.max_jobs) && c.max_jobs >= 1 ? Math.min(c.max_jobs, HARD_MAX_JOBS) : DEFAULT_MAX_JOBS;
  return { maxPages: pages, maxJobs: jobs };
}

/**
 * A board / company identifier that goes into a URL path or host name. Strict on purpose: it comes from the database.
 * @param {unknown} config
 * @param {string} key
 * @param {RegExp} [pattern]
 */
export function identifier(config, key, pattern = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,99}$/) {
  const v = configOf(config)[key];
  if (typeof v !== 'string' || !pattern.test(v.trim())) throw new ConfigError(`"${key}" is missing or not a valid identifier`);
  return v.trim();
}

/** Company name: admin override, then what the source says, then the source's own name in the panel. */
export const companyOf = (config, fromSource, source) =>
  (typeof configOf(config).company_name === 'string' && configOf(config).company_name.trim()) || (typeof fromSource === 'string' && fromSource.trim()) || source.name;

/**
 * Location fields from free text plus whatever the source states explicitly (explicit always wins).
 * @param {unknown} text
 * @param {{city?:string, region?:string, postal?:string, country?:string, workMode?:string}} [explicit]
 */
export function placeFields(text, explicit = {}) {
  const t = typeof text === 'string' ? text.trim() : '';
  const guess = parseLocation(t);
  const country = explicit.country ? normalizeCountry(explicit.country) : guess.country;
  const usable = !explicit.country || country === 'US'; // a state read from the text means nothing next to a non-US country
  const region = explicit.region ? stateCode(explicit.region, { allowGeorgia: country === 'US' }) : usable ? guess.region : undefined;
  /** @type {Record<string, string>} */
  const out = {};
  const put = (k, v) => {
    if (v) out[k] = v;
  };
  put('location', t.slice(0, 200));
  put('loc_city', explicit.city || (usable ? guess.city : undefined));
  put('loc_region', region);
  put('loc_postal', explicit.postal || (usable ? guess.postal : undefined));
  put('loc_country', country);
  put('work_mode', explicit.workMode || guess.workMode);
  return out;
}

/** @param {boolean} complete @param {boolean} [truncated] */
export const result = (complete, truncated = false) => ({ complete: complete && !truncated, truncated });
