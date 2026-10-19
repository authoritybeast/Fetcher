// Generic JSON feed: pure data mapping, no code evaluation.
// Config: {
//   url, items_path?: "data.jobs",                       dotted path to the array (empty = the response itself)
//   map: { external_id: "id", title: "position", ... },  our field name -> dotted path in each item (only the known field names are read)
//   fixed?: { company: "Acme", loc_country: "US" },      constant values for our field names
//   next_url_path?: "links.next",                        dotted path to the next page's URL (same host only)
//   complete?: true,                                      admin asserts the feed lists EVERY open job (otherwise complete is false)
//   max_pages?, max_jobs?
// }
// robots.txt is checked before fetching.
import { getPath } from '../util.mjs';
import { detectWorkMode } from '../normalize.mjs';
import { HttpError } from '../http.mjs';
import { ConfigError, configOf, limitsOf, placeFields, result } from './_common.mjs';

export const MAPPABLE = [
  'external_id', 'title', 'company', 'company_website', 'apply_url', 'source_url', 'location', 'loc_city', 'loc_region', 'loc_postal', 'loc_country',
  'work_mode', 'job_type', 'salary_min', 'salary_max', 'salary_period', 'salary_currency', 'description', 'category', 'posted_at', 'experience_months',
];

const scalar = (v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined);

export function mapItem(item, config, source) {
  const map = configOf(config.map);
  const fixed = configOf(config.fixed);
  /** @type {Record<string, any>} */
  const raw = {};
  for (const field of MAPPABLE) {
    if (Object.prototype.hasOwnProperty.call(fixed, field)) raw[field] = scalar(fixed[field]);
    if (typeof map[field] === 'string') {
      const v = scalar(getPath(item, map[field]));
      if (v !== undefined && v !== '') raw[field] = v;
    }
  }
  if (!raw.company && source.name) raw.company = source.name;
  if (raw.work_mode !== undefined) raw.work_mode = detectWorkMode(raw.work_mode);
  const place = placeFields(raw.location, { city: raw.loc_city, region: raw.loc_region, postal: raw.loc_postal, country: raw.loc_country, workMode: raw.work_mode });
  return { ...raw, ...place, ...(place.work_mode ? { work_mode: place.work_mode } : {}) };
}

export async function* fetchJobs({ source, http, expired }) {
  const config = configOf(source.config);
  if (typeof config.url !== 'string') throw new ConfigError('"url" is missing');
  if (!config.map || typeof config.map !== 'object') throw new ConfigError('"map" is missing');
  const limits = limitsOf(config);
  const origin = new URL(config.url).origin;
  let url = config.url;
  let n = 0;
  for (let page = 0; ; page += 1) {
    if (page >= limits.maxPages || expired?.()) return result(false, true);
    const { json } = await http.getJson(url, { robots: true });
    const items = getPath(json, typeof config.items_path === 'string' ? config.items_path : '');
    if (!Array.isArray(items)) throw new HttpError('"items_path" did not lead to a list');
    for (const item of items) {
      if (n >= limits.maxJobs) return result(false, true);
      n += 1;
      yield mapItem(item, config, source);
    }
    const next = typeof config.next_url_path === 'string' ? scalar(getPath(json, config.next_url_path)) : undefined;
    if (!next || items.length === 0) return result(config.complete === true && n > 0);
    let nextUrl;
    try {
      nextUrl = new URL(String(next), url);
    } catch {
      return result(false, true);
    }
    if (nextUrl.origin !== origin) return result(false, true); // a "next" link to another host is never followed
    url = nextUrl.toString();
  }
}
