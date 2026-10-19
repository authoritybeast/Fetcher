// Lever Postings API (public): GET https://api.lever.co/v0/postings/{company}?mode=json&skip=N&limit=N  (EU: api.eu.lever.co)
// Documented at github.com/lever/postings-api. Config: { company, eu?: true, company_name? }
import { escapeHtml } from '../util.mjs';
import { detectWorkMode } from '../normalize.mjs';
import { HttpError } from '../http.mjs';
import { companyOf, identifier, limitsOf, placeFields, result } from './_common.mjs';

const PAGE = 100;
const WORKPLACE = { 'on-site': 'onsite', onsite: 'onsite', remote: 'remote', hybrid: 'hybrid' };

const periodOf = (interval) => /hour/i.test(interval) ? 'hour' : /day/i.test(interval) ? 'day' : /week/i.test(interval) ? 'week' : /month/i.test(interval) ? 'month' : /year|annual/i.test(interval) ? 'year' : undefined;

export function mapJob(j, source) {
  const lists = Array.isArray(j.lists) ? j.lists.map((l) => `<h3>${escapeHtml(l?.text)}</h3><ul>${l?.content ?? ''}</ul>`).join('') : '';
  const sal = j.salaryRange && typeof j.salaryRange === 'object' ? j.salaryRange : null;
  const loc = j.categories?.location || (Array.isArray(j.categories?.allLocations) ? j.categories.allLocations.join('; ') : '');
  return {
    external_id: j.id,
    title: j.text,
    company: companyOf(source.config, undefined, source),
    apply_url: j.applyUrl || j.hostedUrl,
    source_url: j.hostedUrl,
    ...placeFields(loc, { country: j.country, workMode: WORKPLACE[String(j.workplaceType || '').toLowerCase()] || detectWorkMode(loc) }),
    job_type: j.categories?.commitment,
    description: `${j.description ?? ''}${lists}${j.additional ?? ''}`,
    category: j.categories?.department || j.categories?.team,
    posted_at: j.createdAt,
    ...(sal ? { salary_min: sal.min, salary_max: sal.max, salary_currency: sal.currency, salary_period: periodOf(String(sal.interval || '')) } : {}),
  };
}

export async function* fetchJobs({ source, http, expired }) {
  const company = identifier(source.config, 'company');
  const host = source.config.eu === true ? 'api.eu.lever.co' : 'api.lever.co';
  const limits = limitsOf(source.config);
  let skip = 0;
  let n = 0;
  for (let page = 0; ; page += 1) {
    if (page >= limits.maxPages || expired?.()) return result(false, true);
    const { json } = await http.getJson(`https://${host}/v0/postings/${encodeURIComponent(company)}?mode=json&skip=${skip}&limit=${PAGE}`);
    if (!Array.isArray(json)) throw new HttpError('unexpected response from Lever');
    for (const j of json) {
      if (n >= limits.maxJobs) return result(false, true);
      n += 1;
      yield mapJob(j, source);
    }
    if (json.length < PAGE) return result(true); // a short (or empty) page is the end of the list
    skip += json.length;
  }
}
