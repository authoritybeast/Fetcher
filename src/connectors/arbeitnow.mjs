// Arbeitnow public job board API: GET https://www.arbeitnow.com/api/job-board-api  (paginated; follow links.next)
// Mostly non-US jobs, so with us_only most of them are skipped by the database. Config: { max_pages?, max_jobs? }
import { HttpError } from '../http.mjs';
import { limitsOf, placeFields, result } from './_common.mjs';

const START = 'https://www.arbeitnow.com/api/job-board-api';

export function mapJob(j) {
  return {
    external_id: j.slug,
    title: j.title,
    company: j.company_name,
    apply_url: j.url,
    source_url: j.url,
    ...placeFields(j.location, { workMode: j.remote === true ? 'remote' : undefined }),
    job_type: Array.isArray(j.job_types) ? j.job_types.join(' ') : undefined,
    description: j.description,
    category: Array.isArray(j.tags) && j.tags.length ? String(j.tags[0]) : undefined,
    posted_at: j.created_at, // epoch seconds
  };
}

export async function* fetchJobs({ source, http, expired }) {
  const limits = limitsOf(source.config);
  let url = START;
  let n = 0;
  for (let page = 0; ; page += 1) {
    if (page >= limits.maxPages || expired?.()) return result(false, true);
    const { json } = await http.getJson(url);
    if (!json || !Array.isArray(json.data)) throw new HttpError('unexpected response from Arbeitnow');
    for (const j of json.data) {
      if (n >= limits.maxJobs) return result(false, true);
      n += 1;
      yield mapJob(j);
    }
    const next = json.links?.next;
    if (!next || json.data.length === 0) return result(true);
    let nextUrl;
    try {
      nextUrl = new URL(String(next));
    } catch {
      return result(false, true);
    }
    if (nextUrl.origin !== new URL(START).origin) return result(false, true); // never follow a "next" link to another host
    url = nextUrl.toString();
  }
}
