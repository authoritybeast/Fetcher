// Greenhouse Job Board API (public, no key): GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
// Config: { board_token, company_name? }
import { unescapeIfEscaped } from '../normalize.mjs';
import { HttpError } from '../http.mjs';
import { companyOf, identifier, limitsOf, placeFields, result } from './_common.mjs';

export function mapJob(j, source) {
  return {
    external_id: j.id,
    title: j.title,
    company: companyOf(source.config, j.company_name, source),
    apply_url: j.absolute_url,
    source_url: j.absolute_url,
    ...placeFields(j.location?.name),
    // Greenhouse delivers the description HTML-escaped ("&lt;p&gt;"); decode it once.
    description: unescapeIfEscaped(j.content),
    category: Array.isArray(j.departments) ? j.departments.find((d) => d?.name)?.name : undefined,
    posted_at: j.first_published || j.updated_at,
    // pay_input_ranges has no pay period in the documented shape, so no salary is sent for Greenhouse.
  };
}

export async function* fetchJobs({ source, http }) {
  const board = identifier(source.config, 'board_token');
  const limits = limitsOf(source.config);
  const { json } = await http.getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`);
  if (!json || !Array.isArray(json.jobs)) throw new HttpError('unexpected response from Greenhouse');
  const total = json.meta?.total;
  let complete = !(Number.isFinite(total) && total > json.jobs.length); // the board says there are more than it returned
  let truncated = false;
  let n = 0;
  for (const j of json.jobs) {
    if (n >= limits.maxJobs) {
      truncated = true;
      break;
    }
    n += 1;
    yield mapJob(j, source);
  }
  if (!complete) truncated = true;
  return result(complete, truncated);
}
