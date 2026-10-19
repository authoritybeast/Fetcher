// SmartRecruiters public Posting API: GET https://api.smartrecruiters.com/v1/companies/{company_id}/postings?limit=100&offset=N
// The list has no description; for tier "full" each posting's detail is fetched too (one extra request per job, polite delay).
// Config: { company_id, company_name?, max_pages?, max_jobs? }
import { escapeHtml } from '../util.mjs';
import { HttpError } from '../http.mjs';
import { companyOf, identifier, limitsOf, placeFields, result } from './_common.mjs';

const PAGE = 100;
const SECTIONS = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'];

export function descriptionOf(detail) {
  const s = detail?.jobAd?.sections;
  if (!s || typeof s !== 'object') return undefined;
  return SECTIONS.map((k) => (s[k]?.text ? `${s[k].title ? `<h3>${escapeHtml(s[k].title)}</h3>` : ''}${s[k].text}` : '')).join('');
}

export function mapJob(p, source, detail) {
  const loc = p.location || {};
  const text = loc.fullLocation || [loc.city, loc.region, loc.country && String(loc.country).toUpperCase()].filter(Boolean).join(', ');
  const companyId = p.company?.identifier || source.config.company_id;
  return {
    external_id: p.id,
    title: p.name,
    company: companyOf(source.config, p.company?.name, source),
    apply_url: detail?.applyUrl || detail?.postingUrl || `https://jobs.smartrecruiters.com/${encodeURIComponent(companyId)}/${encodeURIComponent(p.id)}`,
    source_url: detail?.postingUrl || `https://jobs.smartrecruiters.com/${encodeURIComponent(companyId)}/${encodeURIComponent(p.id)}`,
    ...placeFields(text, { city: loc.city, region: loc.region, country: loc.country, workMode: loc.remote === true ? 'remote' : loc.hybrid === true ? 'hybrid' : undefined }),
    job_type: p.typeOfEmployment?.label || p.typeOfEmployment?.id,
    description: descriptionOf(detail),
    category: p.function?.label || p.department?.label || p.industry?.label,
    posted_at: p.releasedDate,
  };
}

export async function* fetchJobs({ source, http, expired }) {
  const company = identifier(source.config, 'company_id');
  const limits = limitsOf(source.config);
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings`;
  let offset = 0;
  let n = 0;
  let complete = true;
  for (let page = 0; ; page += 1) {
    if (page >= limits.maxPages || expired?.()) return result(false, true);
    const { json } = await http.getJson(`${base}?limit=${PAGE}&offset=${offset}`);
    if (!json || !Array.isArray(json.content)) throw new HttpError('unexpected response from SmartRecruiters');
    for (const p of json.content) {
      if (n >= limits.maxJobs || expired?.()) return result(false, true);
      n += 1;
      let detail;
      if (source.tier === 'full' && p.id) {
        try {
          detail = (await http.getJson(`${base}/${encodeURIComponent(p.id)}`)).json;
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) {
            complete = false; // posting vanished between the list and the detail
            continue;
          }
          throw e;
        }
      }
      yield mapJob(p, source, detail);
    }
    offset += json.content.length;
    const total = Number(json.totalFound);
    if (json.content.length === 0 || (Number.isFinite(total) && offset >= total)) return result(complete);
  }
}
