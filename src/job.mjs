// Turns what a connector produced into the exact job object the ingest endpoint accepts (or rejects it).
import { capHtml, cleanSalary, cleanUrl, mapJobType, normalizeCountry, STATE_CODES, toIsoDate } from './normalize.mjs';
import { plainText } from './util.mjs';

const WORK_MODES = new Set(['onsite', 'hybrid', 'remote']);
export const NO_COUNTRY = 'ZZ'; // "cannot tell": the database skips these jobs

/** @param {unknown} v @param {number} max */
const text = (v, max) => {
  const s = plainText(v);
  return s ? s.slice(0, max) : undefined;
};

/**
 * @typedef {object} Source
 * @property {string} id
 * @property {string} name
 * @property {string} kind
 * @property {Record<string, any>} config
 * @property {'facts_only'|'full'} tier
 * @property {boolean} us_only
 * @property {number} fetch_interval_minutes
 * @property {boolean} [requested]
 */

/**
 * @param {Record<string, any>} raw whatever the connector produced (our field names)
 * @param {Pick<Source,'tier'|'us_only'>} source
 * @returns {{ok:true, job:Record<string,any>} | {ok:false, reason:string}}
 */
export function finalizeJob(raw, source) {
  const external_id = text(raw.external_id, 200);
  const title = text(raw.title, 300);
  const company = text(raw.company, 200);
  const apply_url = cleanUrl(raw.apply_url);
  if (!external_id) return { ok: false, reason: 'no external_id' };
  if (!title) return { ok: false, reason: 'no title' };
  if (!company) return { ok: false, reason: 'no company' };
  if (!apply_url) return { ok: false, reason: 'no https apply_url' };

  /** @type {Record<string, any>} */
  const job = { external_id, title, company, apply_url };
  const set = (k, v) => {
    if (v !== undefined && v !== null && v !== '') job[k] = v;
  };
  set('company_website', cleanUrl(raw.company_website));
  set('source_url', cleanUrl(raw.source_url));
  set('location', text(raw.location, 200));
  set('loc_city', text(raw.loc_city, 100));

  const region = typeof raw.loc_region === 'string' ? raw.loc_region.trim().toUpperCase() : '';
  const postal = typeof raw.loc_postal === 'string' ? raw.loc_postal.trim() : '';
  let country = raw.loc_country ? normalizeCountry(raw.loc_country) : undefined;
  if (country && !/^[A-Z]{2}$/.test(country)) country = undefined;
  if (STATE_CODES.has(region) && (!country || country === 'US')) {
    set('loc_region', region);
    country = 'US'; // a US state code can only come from US evidence
    if (/^\d{5}(-\d{4})?$/.test(postal)) set('loc_postal', postal);
  }
  if (!country && source.us_only) country = NO_COUNTRY; // never guess US
  set('loc_country', country);

  if (WORK_MODES.has(raw.work_mode)) job.work_mode = raw.work_mode;
  set('job_type', mapJobType(raw.job_type));
  Object.assign(job, cleanSalary({ min: raw.salary_min, max: raw.salary_max, period: raw.salary_period, currency: raw.salary_currency }));

  // The description is only ever transmitted for tier "full" (the database enforces it too).
  if (source.tier === 'full' && typeof raw.description === 'string' && raw.description.trim()) set('description', capHtml(raw.description, 50_000));

  set('category', text(raw.category, 100));
  set('posted_at', toIsoDate(raw.posted_at));
  const exp = Number(raw.experience_months);
  if (Number.isInteger(exp) && exp >= 0 && exp <= 600) job.experience_months = exp;
  return { ok: true, job };
}
