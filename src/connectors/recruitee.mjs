// Recruitee public offers API: GET https://{company}.recruitee.com/api/offers/   (all published offers, no pagination)
// Config: { company, company_name? }   `company` is the subdomain and is validated strictly (it becomes part of the host name).
import { HttpError } from '../http.mjs';
import { companyOf, identifier, limitsOf, placeFields, result } from './_common.mjs';

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function mapJob(o, source) {
  const text = o.location || [o.city, o.state_code || o.state, o.country].filter(Boolean).join(', ');
  const s = o.salary && typeof o.salary === 'object' ? o.salary : null;
  return {
    external_id: o.id ?? o.guid,
    title: o.title,
    company: companyOf(source.config, o.company_name, source),
    apply_url: o.careers_apply_url || o.careers_url,
    source_url: o.careers_url,
    ...placeFields(text, {
      city: o.city,
      region: o.state_code,
      postal: o.postal_code,
      country: o.country_code,
      workMode: o.remote === true ? 'remote' : o.hybrid === true ? 'hybrid' : o.on_site === true ? 'onsite' : undefined,
    }),
    job_type: o.employment_type_code,
    description: `${o.description ?? ''}${o.requirements ?? ''}`,
    category: o.department || o.category_code,
    posted_at: o.published_at || o.created_at,
    ...(s ? { salary_min: s.min, salary_max: s.max, salary_period: s.period, salary_currency: s.currency } : {}),
  };
}

export async function* fetchJobs({ source, http }) {
  const company = identifier(source.config, 'company', SUBDOMAIN);
  const limits = limitsOf(source.config);
  const { json } = await http.getJson(`https://${company}.recruitee.com/api/offers/`);
  if (!json || !Array.isArray(json.offers)) throw new HttpError('unexpected response from Recruitee');
  let n = 0;
  for (const o of json.offers) {
    if (o?.status && o.status !== 'published') continue;
    if (n >= limits.maxJobs) return result(false, true);
    n += 1;
    yield mapJob(o, source);
  }
  return result(true);
}
