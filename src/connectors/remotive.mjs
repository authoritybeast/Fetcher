// Remotive public API: GET https://remotive.com/api/remote-jobs[?limit=N]
// Documented limits (github.com/remotive-com/remote-jobs-api): fetch at most 4 times a day, never more than 2 requests a minute;
// jobs are delayed 24 h; link back to the Remotive URL and name Remotive; do not pass the jobs on to third-party job sites.
// The connector refuses to run when the source's schedule would exceed 4 fetches a day, whatever the hourly workflow does.
// Config: { limit?, max_jobs? }
import { HttpError } from '../http.mjs';
import { ConfigError, limitsOf, placeFields, result } from './_common.mjs';
import { normalizeCountry } from '../normalize.mjs';

export const MAX_FETCHES_PER_DAY = 4;
export const MIN_INTERVAL_MINUTES = (24 * 60) / MAX_FETCHES_PER_DAY; // 360

/** "USA Only", "Worldwide", "Germany" ... -> an ISO country only when the text says so. */
export function countryOf(text) {
  const t = String(text ?? '').replace(/\b(only|based|residents?)\b/gi, '').trim();
  if (/^(usa|us|united states)\b/i.test(t) || /\bunited states\b/i.test(t)) return 'US';
  return /^[A-Za-z ]{4,40}$/.test(t) && !/worldwide|anywhere|global|europe|emea|apac|latam|asia/i.test(t) ? normalizeCountry(t) : undefined;
}

export function mapJob(j, source) {
  const country = countryOf(j.candidate_required_location);
  return {
    external_id: j.id,
    title: j.title,
    company: j.company_name,
    apply_url: j.url,
    source_url: j.url,
    ...placeFields(j.candidate_required_location, { country, workMode: 'remote' }),
    job_type: j.job_type,
    description: j.description,
    category: j.category,
    posted_at: j.publication_date,
    // `salary` is free text on Remotive, so no salary is sent.
  };
}

export async function* fetchJobs({ source, http }) {
  if (!(Number(source.fetch_interval_minutes) >= MIN_INTERVAL_MINUTES)) {
    throw new ConfigError(`Remotive allows ${MAX_FETCHES_PER_DAY} fetches a day: set the fetch interval to ${MIN_INTERVAL_MINUTES} minutes or more`);
  }
  const limits = limitsOf(source.config);
  const limit = Number.isInteger(source.config?.limit) && source.config.limit > 0 ? `?limit=${Math.min(source.config.limit, 1000)}` : '';
  const { json } = await http.getJson(`https://remotive.com/api/remote-jobs${limit}`); // exactly one request per run
  if (!json || !Array.isArray(json.jobs)) throw new HttpError('unexpected response from Remotive');
  let n = 0;
  for (const j of json.jobs) {
    if (n >= limits.maxJobs) return result(false, true);
    n += 1;
    yield mapJob(j, source);
  }
  return result(!limit && n > 0); // a `limit` makes the list a window
}
