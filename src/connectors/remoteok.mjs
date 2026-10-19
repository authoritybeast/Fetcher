// Remote OK public API: GET https://remoteok.com/api  -> JSON array; element 0 is a legal notice, not a job.
// Terms (as reported for the API's first element): link back to the job's Remote OK page (followed link) and name Remote OK as the source.
// We always send `source_url` (the job page on remoteok.com); the portal shows the attribution from the source's attribution text.
// Config: { max_jobs? }
import { HttpError } from '../http.mjs';
import { limitsOf, placeFields, result } from './_common.mjs';

export function mapJob(j, source) {
  const min = Number(j.salary_min);
  const max = Number(j.salary_max);
  return {
    external_id: j.id ?? j.slug,
    title: j.position,
    company: j.company,
    apply_url: j.apply_url || j.url,
    source_url: j.url,
    ...placeFields(j.location, { workMode: 'remote' }),
    description: j.description,
    category: Array.isArray(j.tags) && j.tags.length ? String(j.tags[0]) : undefined,
    posted_at: j.date || j.epoch,
    // Remote OK publishes annual USD figures; 0 means "not given".
    ...(min > 0 && max > 0 ? { salary_min: min, salary_max: max, salary_period: 'year', salary_currency: 'USD' } : {}),
  };
}

export async function* fetchJobs({ source, http }) {
  const limits = limitsOf(source.config);
  const { json } = await http.getJson('https://remoteok.com/api');
  if (!Array.isArray(json)) throw new HttpError('unexpected response from Remote OK');
  let n = 0;
  for (const j of json) {
    if (!j || typeof j !== 'object' || j.legal || !(j.id || j.slug) || !j.position) continue; // skips the legal notice at index 0
    if (n >= limits.maxJobs) return result(false, true);
    n += 1;
    yield mapJob(j, source);
  }
  return result(n > 0);
}
