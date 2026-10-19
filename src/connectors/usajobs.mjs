// USAJOBS Search API: GET https://data.usajobs.gov/api/search  with headers  Host, User-Agent (= your registered e-mail), Authorization-Key.
// Needs env USAJOBS_API_KEY and USAJOBS_EMAIL. Federal jobs are US jobs unless the location says otherwise.
// Config: { keyword?, location?, organization?, results_per_page? (<=500), max_pages?, max_jobs? }
import { escapeHtml } from '../util.mjs';
import { mapJobType, normalizeCountry, stateCode } from '../normalize.mjs';
import { HttpError } from '../http.mjs';
import { ConfigError, configOf, limitsOf, result } from './_common.mjs';

const toPara = (s) => String(s ?? '').split(/\r?\n+/).map((l) => l.trim()).filter(Boolean).map((l) => `<p>${escapeHtml(l)}</p>`).join('');
const toList = (a) => (Array.isArray(a) && a.length ? `<ul>${a.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '');

export function descriptionOf(d) {
  const det = d?.UserArea?.Details || {};
  const duties = Array.isArray(det.MajorDuties) ? toList(det.MajorDuties) : toPara(det.MajorDuties);
  return [
    toPara(det.JobSummary),
    duties ? `<h3>Major duties</h3>${duties}` : '',
    d?.QualificationSummary ? `<h3>Qualifications</h3>${toPara(d.QualificationSummary)}` : '',
    det.Requirements ? `<h3>Requirements</h3>${toPara(det.Requirements)}` : '',
    det.Education ? `<h3>Education</h3>${toPara(det.Education)}` : '',
  ].join('');
}

export function mapJob(item) {
  const d = item?.MatchedObjectDescriptor || {};
  const locs = Array.isArray(d.PositionLocation) ? d.PositionLocation : [];
  const first = locs[0] || {};
  const rem = Array.isArray(d.PositionRemuneration) ? d.PositionRemuneration[0] : null;
  const period = rem?.RateIntervalCode === 'PA' ? 'year' : rem?.RateIntervalCode === 'PH' ? 'hour' : undefined; // other codes are not a plain pay period
  const country = normalizeCountry(first.CountryCode) || 'US';
  const remote = d.UserArea?.Details?.RemoteIndicator === true || locs.some((l) => /remote|anywhere in the u/i.test(String(l?.LocationName)));
  return {
    external_id: item?.MatchedObjectId || d.PositionID,
    title: d.PositionTitle,
    company: d.OrganizationName || d.DepartmentName,
    apply_url: Array.isArray(d.ApplyURI) ? d.ApplyURI[0] : d.PositionURI,
    source_url: d.PositionURI,
    location: locs.slice(0, 3).map((l) => l?.LocationName).filter(Boolean).join('; '),
    loc_city: first.CityName,
    loc_region: country === 'US' ? stateCode(first.CountrySubDivisionCode) : undefined,
    loc_country: country,
    work_mode: remote ? 'remote' : undefined,
    job_type: mapJobType(Array.isArray(d.PositionSchedule) ? d.PositionSchedule[0]?.Name : undefined),
    description: descriptionOf(d),
    category: Array.isArray(d.JobCategory) ? d.JobCategory[0]?.Name : undefined,
    posted_at: d.PublicationStartDate,
    ...(period && rem ? { salary_min: rem.MinimumRange, salary_max: rem.MaximumRange, salary_period: period, salary_currency: 'USD' } : {}),
  };
}

export async function* fetchJobs({ source, env, http, expired }) {
  const key = env.USAJOBS_API_KEY;
  const email = env.USAJOBS_EMAIL;
  if (!key || !email) throw new ConfigError('USAJOBS_API_KEY and USAJOBS_EMAIL must be set as secrets');
  const c = configOf(source.config);
  const limits = limitsOf(c);
  const perPage = Number.isInteger(c.results_per_page) ? Math.min(500, Math.max(10, c.results_per_page)) : 250;
  const filters = new URLSearchParams();
  for (const [param, key2] of [['Keyword', 'keyword'], ['LocationName', 'location'], ['Organization', 'organization']]) {
    if (typeof c[key2] === 'string' && c[key2].trim()) filters.set(param, c[key2].trim().slice(0, 200));
  }
  let n = 0;
  for (let page = 1; ; page += 1) {
    if (page > limits.maxPages || expired?.()) return result(false, true);
    const q = new URLSearchParams(filters);
    q.set('ResultsPerPage', String(perPage));
    q.set('Page', String(page));
    // The key and the e-mail go only to data.usajobs.gov (the HTTP client drops custom headers on a redirect to another host).
    const { json } = await http.getJson(`https://data.usajobs.gov/api/search?${q}`, { headers: { 'user-agent': email, 'authorization-key': key } });
    const items = json?.SearchResult?.SearchResultItems;
    if (!Array.isArray(items)) throw new HttpError('unexpected response from USAJOBS');
    for (const it of items) {
      if (n >= limits.maxJobs) return result(false, true);
      n += 1;
      yield mapJob(it);
    }
    const pages = Number(json.SearchResult?.UserArea?.NumberOfPages);
    if (items.length === 0 || (Number.isFinite(pages) && page >= pages)) return result(true);
  }
}
