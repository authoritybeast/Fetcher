// Ashby public job board posting API: GET https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true
// One response holds every listed posting (no pagination). Config: { board, company_name? }
import { detectWorkMode } from '../normalize.mjs';
import { HttpError } from '../http.mjs';
import { companyOf, identifier, limitsOf, placeFields, result } from './_common.mjs';

const WORKPLACE = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite', 'on-site': 'onsite' };

/** compensation.summaryComponents[] with compensationType "Salary", interval like "1 YEAR" / "1 HOUR". */
function salaryOf(comp) {
  const parts = Array.isArray(comp?.summaryComponents) ? comp.summaryComponents.filter((c) => /salary/i.test(String(c?.compensationType))) : [];
  if (parts.length !== 1) return {}; // none, or several: not unambiguous
  const c = parts[0];
  const m = /^\s*1?\s*(hour|day|week|month|year)s?\s*$/i.exec(String(c.interval || ''));
  if (!m) return {};
  return { salary_min: c.minValue, salary_max: c.maxValue, salary_period: m[1].toLowerCase(), salary_currency: c.currencyCode || c.currency };
}

export function mapJob(j, source) {
  const addr = j.address?.postalAddress || {};
  return {
    external_id: j.id,
    title: j.title,
    company: companyOf(source.config, undefined, source),
    apply_url: j.applyUrl || j.jobUrl,
    source_url: j.jobUrl,
    ...placeFields(j.location, {
      city: addr.addressLocality,
      region: addr.addressRegion,
      country: addr.addressCountry,
      workMode: WORKPLACE[String(j.workplaceType || '').toLowerCase()] || (j.isRemote === true ? 'remote' : detectWorkMode(j.location)),
    }),
    job_type: j.employmentType,
    description: j.descriptionHtml,
    category: j.department || j.team,
    posted_at: j.publishedAt,
    ...salaryOf(j.compensation),
  };
}

export async function* fetchJobs({ source, http }) {
  const board = identifier(source.config, 'board');
  const limits = limitsOf(source.config);
  const { json } = await http.getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`);
  if (!json || !Array.isArray(json.jobs)) throw new HttpError('unexpected response from Ashby');
  let n = 0;
  for (const j of json.jobs) {
    if (j?.isListed === false) continue;
    if (n >= limits.maxJobs) return result(false, true);
    n += 1;
    yield mapJob(j, source);
  }
  return result(true);
}
